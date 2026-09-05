// ============================================================================
// AgentCore Code Interpreter client (server-only).
//
// A secure Python sandbox (pandas/numpy/matplotlib/dateutil preinstalled, NO
// network egress) for exact CALCULATIONS the answer must not get wrong:
// settlement allocation, limitations/repose date math, data aggregation.
//
// One module-level session is reused across calls (cold start ~2s, then
// sub-second). Executions run with clearContext=false so the sandbox FILESYSTEM
// (and state) persist across calls within a session — that is what lets an
// uploaded file be written, then read/processed by a later run_python, then its
// output file (xlsx/docx/pdf/png) read back for download. Single-instance only —
// a second server process gets its own session (fine for dev; the seam to a
// per-actor pool is ensureSession()). The session is recreated before its
// absolute TTL and on any error.
// ============================================================================
import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  type InvokeCodeInterpreterCommandInput,
  StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const REGION = process.env["BEDROCK_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";
const INTERPRETER_ID = process.env["CODE_INTERPRETER_ID"] || "aws.codeinterpreter.v1";
const SESSION_TTL_S = 1800; // 30 min absolute TTL
const TTL_MARGIN_MS = 120_000; // recreate 2 min before the absolute TTL
const MAX_INLINE_BYTES = 4 * 1024 * 1024; // cap base64-in-SSE payload at ~4MB

// Files the caller already knows about (uploads written via writeFile, plus
// outputs already surfaced) — so collectNewArtifacts() only ever reports files
// the sandbox NEWLY created. Cleared whenever a fresh session is started.
const seenFiles = new Set<string>();
const norm = (p: string) => p.replace(/^\.\//, "").replace(/^\/+/, "");
// The sandbox image ships with files in the working dir (package.json, etc).
// Snapshot them into seenFiles before any user code runs so collectNewArtifacts
// only ever reports files the user's run_python actually created.
let baselinedFor: string | null = null;
async function baseline(): Promise<void> {
  try {
    const s = await ensureSession();
    if (baselinedFor === s.id) return;
    for (const f of await listArtifacts()) seenFiles.add(norm(f.name));
    baselinedFor = s.id;
  } catch {
    /* best effort — if this fails the tool still works, env files may surface once */
  }
}

let _client: BedrockAgentCoreClient | null = null;
function client(): BedrockAgentCoreClient {
  return (_client ??= new BedrockAgentCoreClient({ region: REGION }));
}

let session: { id: string; startedAt: number } | null = null;
let starting: Promise<{ id: string; startedAt: number }> | null = null;

async function ensureSession(): Promise<{ id: string; startedAt: number }> {
  if (session && Date.now() - session.startedAt < SESSION_TTL_S * 1000 - TTL_MARGIN_MS) return session;
  if (starting) return starting;
  starting = (async () => {
    if (session) {
      const old = session.id;
      try {
        await client().send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: INTERPRETER_ID, sessionId: old }));
      } catch {
        /* best effort */
      }
    }
    const res = await client().send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: INTERPRETER_ID,
        name: "lit-ai",
        sessionTimeoutSeconds: SESSION_TTL_S,
      }),
    );
    session = { id: res.sessionId ?? "", startedAt: Date.now() };
    seenFiles.clear();
    baselinedFor = null; // re-snapshot the new sandbox's shipped files on next use
    return session;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export type CodeResult = { text: string; images: string[]; isError: boolean };

type ContentItem = { type?: string; text?: string; data?: string; source?: { data?: string }; name?: string; path?: string };

/** Drain the InvokeCodeInterpreter event stream into its content items + error flag. */
async function drain(resp: unknown): Promise<{ content: ContentItem[]; isError: boolean }> {
  const content: ContentItem[] = [];
  let isError = false;
  const stream = (resp as { stream?: AsyncIterable<unknown> }).stream;
  if (stream) {
    for await (const ev of stream) {
      const r = (ev as { result?: { content?: ContentItem[]; isError?: boolean } }).result;
      if (!r) continue;
      if (r.isError) isError = true;
      for (const c of r.content ?? []) content.push(c);
    }
  }
  return { content, isError };
}

async function invoke(name: string, args: Record<string, unknown>): Promise<{ content: ContentItem[]; isError: boolean }> {
  const sess = await ensureSession();
  const resp = await client().send(
    new InvokeCodeInterpreterCommand({
      codeInterpreterIdentifier: INTERPRETER_ID,
      sessionId: sess.id,
      name: name as InvokeCodeInterpreterCommandInput["name"],
      arguments: args,
    }),
  );
  return drain(resp);
}

async function invokeOnce(code: string): Promise<CodeResult> {
  const { content, isError } = await invoke("executeCode", { code, language: "python", clearContext: false });
  let text = "";
  const images: string[] = [];
  for (const c of content) {
    if (c.type === "text" && typeof c.text === "string") text += c.text;
    else if (c.type === "image") {
      const d = c.data ?? c.source?.data;
      if (d) images.push(d);
    }
  }
  return { text, images, isError };
}

/** Run a snippet of Python in the sandbox. Retries once on a dead session. */
export async function runPython(code: string): Promise<CodeResult> {
  await baseline();
  try {
    return await invokeOnce(code);
  } catch {
    session = null; // session may have expired/died — recreate and retry once
    return await invokeOnce(code);
  }
}

/** Write a text file into the sandbox (an upload the model / run_python can read).
 *  Use a RELATIVE path (the sandbox rejects absolute paths like /tmp as traversal). */
export async function writeFile(path: string, text: string): Promise<void> {
  await baseline();
  const { isError, content } = await invoke("writeFiles", { content: [{ path, text }] });
  if (isError) throw new Error(`writeFile failed: ${content.map((c) => c.text ?? "").join("").slice(0, 200)}`);
  seenFiles.add(norm(path)); // an upload, not a run_python output — don't surface it
}

/** Write a BINARY file (base64 payload) into the sandbox. The writeFiles tool
 *  is text-only, so decode via run_python. Use for uploads like xlsx/pdf/images.
 *  RELATIVE path only (absolute paths are rejected as traversal). */
export async function writeFileB64(path: string, b64: string): Promise<void> {
  await baseline();
  const p = norm(path);
  // base64 has no quotes/newlines from btoa, so a triple-quoted literal is safe.
  const code = `import base64\nopen(${JSON.stringify(p)},'wb').write(base64.b64decode("""${b64}"""))\nprint('WROTE',${JSON.stringify(p)})`;
  const { text, isError } = await invokeOnce(code);
  if (isError) throw new Error(`writeFileB64 failed: ${text.slice(0, 200)}`);
  seenFiles.add(p); // an upload, not an output
}

export type ExtractedDoc = {
  kind: string; // table | pdf | docx | pptx | html | image | text | ...
  meta: Record<string, unknown>;
  text: string; // full extracted text (also written to <name>.extracted.txt in the sandbox)
  chars: number;
  error?: string;
};

// Native, per-type text extraction run INSIDE the sandbox (pdfplumber / python-docx
// / pandas / python-pptx / bs4 / PIL are all preinstalled). Also writes the full
// text to `<name>.extracted.txt` so read_document can retrieve passages on demand
// for large files without injecting them into the model context.
const EXTRACT_PY = (name: string) => `
import json, os
name = ${JSON.stringify(name)}
ext = name.rsplit('.',1)[-1].lower() if '.' in name else ''
out = {"kind": ext or "text", "meta": {}, "text": ""}
try:
    if ext in ("csv","tsv"):
        import pandas as pd
        df = pd.read_csv(name, sep=('\\t' if ext=='tsv' else ','))
        out["kind"]="table"
        out["meta"]={"rows":int(df.shape[0]),"cols":int(df.shape[1]),"columns":[str(c) for c in df.columns][:60]}
        try: desc = df.describe(include='all').to_string()[:2500]
        except Exception: desc = ""
        out["text"] = "COLUMNS: %s\\nSHAPE: %sx%s\\n\\nHEAD (up to 40 rows):\\n%s\\n\\nSUMMARY:\\n%s" % (list(df.columns), df.shape[0], df.shape[1], df.head(40).to_csv(index=False), desc)
    elif ext in ("xlsx","xls"):
        import pandas as pd
        xl = pd.ExcelFile(name); parts=[]; sheets=[]
        for s in xl.sheet_names[:12]:
            df = xl.parse(s)
            sheets.append({"sheet":str(s),"rows":int(df.shape[0]),"cols":int(df.shape[1])})
            parts.append("=== SHEET: %s (%sx%s) ===\\nCOLUMNS: %s\\n%s" % (s, df.shape[0], df.shape[1], list(df.columns), df.head(25).to_csv(index=False)))
        out["kind"]="table"; out["meta"]={"sheets":sheets}; out["text"]="\\n\\n".join(parts)
    elif ext=="pdf":
        import pdfplumber
        pages=[]
        with pdfplumber.open(name) as pdf:
            n=len(pdf.pages)
            for i,pg in enumerate(pdf.pages):
                pages.append("[page %d]\\n%s" % (i+1, pg.extract_text() or ""))
        out["kind"]="pdf"; out["meta"]={"pages":n}; out["text"]="\\n\\n".join(pages)
    elif ext=="docx":
        import docx
        d=docx.Document(name)
        paras=[p.text for p in d.paragraphs]
        heads=[p.text for p in d.paragraphs if p.style and p.style.name and p.style.name.lower().startswith('heading') and p.text.strip()]
        out["kind"]="docx"; out["meta"]={"paragraphs":len(paras),"headings":heads[:50]}; out["text"]="\\n".join(paras)
    elif ext=="pptx":
        from pptx import Presentation
        prs=Presentation(name); slides=[]
        for i,sl in enumerate(prs.slides):
            t=[sh.text_frame.text for sh in sl.shapes if sh.has_text_frame]
            slides.append("[slide %d]\\n%s" % (i+1, "\\n".join(t)))
        out["kind"]="pptx"; out["meta"]={"slides":len(prs.slides)}; out["text"]="\\n\\n".join(slides)
    elif ext in ("html","htm"):
        from bs4 import BeautifulSoup
        html=open(name,encoding='utf-8',errors='replace').read()
        out["kind"]="html"; out["text"]=BeautifulSoup(html,'html.parser').get_text('\\n')
    elif ext in ("png","jpg","jpeg","gif","bmp","webp","tiff"):
        from PIL import Image
        im=Image.open(name)
        out["kind"]="image"; out["meta"]={"width":im.width,"height":im.height,"format":im.format,"mode":im.mode}
        out["text"]="[image %dx%d %s] (no text extracted; vision not enabled)" % (im.width, im.height, im.format)
    else:
        data=open(name,'rb').read()
        try:
            import chardet; enc=chardet.detect(data[:4096]).get('encoding') or 'utf-8'
        except Exception: enc='utf-8'
        out["kind"]= ext or "text"; out["text"]=data.decode(enc, errors='replace')
    with open(name+'.extracted.txt','w',encoding='utf-8') as f: f.write(out["text"])
    out["chars"]=len(out["text"])
except Exception as e:
    out["error"]=str(e)[:300]; out["chars"]=len(out.get("text",""))
print('<<DOC>>'+json.dumps(out)+'<<END>>')
`;

export async function extractDocument(name: string): Promise<ExtractedDoc> {
  await baseline();
  const { text, isError } = await invokeOnce(EXTRACT_PY(norm(name)));
  seenFiles.add(norm(name) + ".extracted.txt"); // sidecar, not a user-facing output
  const m = text.match(/<<DOC>>([\s\S]*?)<<END>>/);
  if (!m || !m[1]) {
    return { kind: "text", meta: {}, text: "", chars: 0, error: isError ? text.slice(0, 300) : "no extractor output" };
  }
  try {
    const doc = JSON.parse(m[1]) as ExtractedDoc;
    return { kind: doc.kind ?? "text", meta: doc.meta ?? {}, text: doc.text ?? "", chars: doc.chars ?? (doc.text?.length ?? 0), ...(doc.error ? { error: doc.error } : {}) };
  } catch {
    return { kind: "text", meta: {}, text: "", chars: 0, error: "extractor JSON parse failed" };
  }
}

/** Retrieve passages from a previously-extracted document's sidecar text. With a
 *  query, returns the best-matching chunks (keyword overlap) with context; without
 *  one, returns the opening slice. Scales large docs without context injection. */
export async function readDocument(name: string, query: string, maxChars = 4000): Promise<string> {
  await baseline();
  const code = `
import os, re, json
name = ${JSON.stringify(norm(name))}
q = ${JSON.stringify(query || "")}
maxc = ${Math.max(500, Math.min(maxChars, 12000))}
p = name + '.extracted.txt'
if not os.path.exists(p):
    print('<<DOCR>>'+json.dumps({"missing":True})+'<<END>>')
else:
    text = open(p, encoding='utf-8', errors='replace').read()
    if not q.strip():
        print('<<DOCR>>'+json.dumps({"text": text[:maxc], "truncated": len(text)>maxc})+'<<END>>')
    else:
        terms = [t for t in re.findall(r'\\w+', q.lower()) if len(t)>2]
        # split into paragraph-ish chunks, score by distinct-term hits then total hits
        chunks = [c.strip() for c in re.split(r'\\n\\s*\\n', text) if c.strip()]
        scored = []
        for c in chunks:
            cl = c.lower()
            distinct = sum(1 for t in set(terms) if t in cl)
            total = sum(cl.count(t) for t in terms)
            if distinct: scored.append((distinct, total, c))
        scored.sort(key=lambda x:(x[0],x[1]), reverse=True)
        picked=[]; used=0
        for _,_,c in scored:
            seg = c[:1500]
            if used+len(seg) > maxc: break
            picked.append(seg); used+=len(seg)
        if not picked:
            print('<<DOCR>>'+json.dumps({"text":"", "nohits":True})+'<<END>>')
        else:
            print('<<DOCR>>'+json.dumps({"text":"\\n\\n---\\n\\n".join(picked), "matches":len(picked)})+'<<END>>')
`;
  const { text } = await invokeOnce(code);
  const m = text.match(/<<DOCR>>([\s\S]*?)<<END>>/);
  if (!m || !m[1]) return `Could not read "${name}".`;
  try {
    const r = JSON.parse(m[1]) as { missing?: boolean; nohits?: boolean; text?: string; truncated?: boolean; matches?: number };
    if (r.missing) return `"${name}" is no longer in the sandbox (session may have rotated — ask the attorney to re-upload).`;
    if (r.nohits) return `No passages in "${name}" matched "${query}".`;
    return (r.text || "").trim() || `(empty result for "${name}")`;
  } catch {
    return `Could not parse read_document result for "${name}".`;
  }
}

/** Download a file from the sandbox as base64 (binary-safe), via run_python — the
 *  dedicated readFiles tool's arg shape is unreliable and this handles binary
 *  (xlsx/docx/pdf/png) cleanly. Returns null if the file is missing. */
export async function getFile(path: string): Promise<string | null> {
  const code = `import base64,os\np=${JSON.stringify(path)}\nprint('<<B64>>'+(base64.b64encode(open(p,'rb').read()).decode() if os.path.exists(p) else '')+'<<END>>')`;
  const { text, isError } = await invokeOnce(code);
  if (isError) return null;
  const m = text.match(/<<B64>>([\s\S]*?)<<END>>/);
  return m && m[1] ? m[1] : null;
}

export type Artifact = { name: string; size: number };

/** List files in the sandbox working dir (name + byte size), via run_python. */
export async function listArtifacts(): Promise<Artifact[]> {
  const code = `import os,json\nout=[{'name':f,'size':os.path.getsize(f)} for f in sorted(os.listdir('.')) if os.path.isfile(f)]\nprint('<<JSON>>'+json.dumps(out)+'<<END>>')`;
  const { text } = await invokeOnce(code);
  const m = text.match(/<<JSON>>([\s\S]*?)<<END>>/);
  if (!m) return [];
  try {
    return JSON.parse(m[1]) as Artifact[];
  } catch {
    return [];
  }
}

export type NewArtifact = { name: string; size: number; dataB64: string | null };

/** Find files the sandbox created since the last call (excluding uploads and
 *  files already reported), and fetch each as base64 for download. Files above
 *  MAX_INLINE_BYTES return dataB64=null (name/size only — inline deferred).
 *  Best-effort: call after a successful run_python so charts saved to disk and
 *  generated reports (xlsx/docx/pdf/csv) surface as downloadable chat artifacts. */
export async function collectNewArtifacts(): Promise<NewArtifact[]> {
  await baseline();
  const files = await listArtifacts();
  const out: NewArtifact[] = [];
  for (const f of files) {
    const name = norm(f.name);
    if (seenFiles.has(name)) continue;
    if (name.startsWith(".") || name.startsWith("__")) {
      seenFiles.add(name); // skip dotfiles / __pycache__ etc, but don't re-scan them
      continue;
    }
    seenFiles.add(name);
    if (f.size > MAX_INLINE_BYTES) {
      out.push({ name, size: f.size, dataB64: null });
      continue;
    }
    out.push({ name, size: f.size, dataB64: await getFile(name) });
  }
  return out;
}

export function codeInterpreterEnabled(): boolean {
  return true; // reachable under the default AWS credential chain (SigV4)
}
