import type {
  AnalysisReport,
  EvidenceRow,
  ExecutionContext,
  ExecutionResult,
  StepConfig,
  SourceFile,
} from "./types";

import {
  evidence,
  makeReport,
  sourceFiles,
  sourceLines,
  reportCsv,
  matchesTerm,
  strictDate,
} from "./evidence.ts";
import { practiceRecipeNames, runPracticeRecipe } from "./practice-recipes.ts";
export { sourceLines, reportCsv } from "./evidence.ts";

export const recipeNames: Record<string, string> = {
  ...practiceRecipeNames,
  parties: "Parties & people",
  chronology: "Source chronology",
  issues: "Issue evidence matrix",
  requests: "Discovery response index",
  privilege: "Privilege review queue",
  citations: "Citation quality review",
  plain: "Plain-language editor",
  compare: "Document comparison",
  emails: "Email briefing",
  actions: "Actions & commitments",
  clauses: "Clause review",
  manifest: "File & exhibit index",
  fields: "Custom field extraction",
  webbrief: "Public source brief",
  changes: "Page change report",
};
const location = (l: import("./evidence").SourceLine) =>
  `${l.source}${l.page ? ` · p. ${l.page}` : ""} · line ${l.line}`;
export function isAnalysisReport(v: unknown): v is AnalysisReport {
  return (
    !!v &&
    typeof v === "object" &&
    (v as AnalysisReport).type === "analysis-report" &&
    typeof (v as AnalysisReport).title === "string" &&
    typeof (v as AnalysisReport).summary === "string" &&
    typeof (v as AnalysisReport).text === "string" &&
    Array.isArray((v as AnalysisReport).columns) &&
    (v as AnalysisReport).columns.every((c) => typeof c === "string") &&
    Array.isArray((v as AnalysisReport).notes) &&
    (v as AnalysisReport).notes.every((n) => typeof n === "string") &&
    Array.isArray((v as AnalysisReport).rows) &&
    (v as AnalysisReport).rows.every(
      (r) =>
        r &&
        typeof r.id === "string" &&
        typeof r.source === "string" &&
        typeof r.excerpt === "string" &&
        Number.isInteger(r.line) &&
        r.cells &&
        typeof r.cells === "object" &&
        Object.values(r.cells).every((c) => typeof c === "string") &&
        ["Found", "Missing", "Changed", "Review"].includes(r.status),
    )
  );
}
const dates =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
function dateKey(s: string) {
  if (s.includes("/")) return "9999";
  if (/^\d{4}-/.test(s) && !strictDate(s)) return "9999";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "9999" : d.toISOString().slice(0, 10);
}
export function compareSources(before: SourceFile, after: SourceFile): EvidenceRow[] {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  const a = sourceLines([before]),
    b = sourceLines([after]);
  const left = new Map<string, number>(),
    right = new Map<string, number>();
  a.forEach((l) => left.set(norm(l.text), (left.get(norm(l.text)) || 0) + 1));
  b.forEach((l) => right.set(norm(l.text), (right.get(norm(l.text)) || 0) + 1));
  const result: EvidenceRow[] = [];
  for (const [list, opposite, change] of [
    [a, new Map(right), "Removed"],
    [b, new Map(left), "Added"],
  ] as const) {
    for (const l of list) {
      const k = norm(l.text),
        count = opposite.get(k) || 0;
      if (count) opposite.set(k, count - 1);
      else result.push(evidence(l, { Change: change, Text: l.text }, "Changed"));
    }
  }
  return result;
}
export function analyzeRecipe(
  recipe: string,
  ctx: ExecutionContext,
  config: StepConfig = {},
): ExecutionResult {
  if (practiceRecipeNames[recipe]) return runPracticeRecipe(recipe, ctx, config);
  if (!recipeNames[recipe]) throw new Error("Choose a supported analysis recipe.");
  const files = sourceFiles(ctx);
  const lines = sourceLines(files);
  const fields = ctx.inputs.fields || {};
  let columns: string[] = [],
    rows: EvidenceRow[] = [],
    extra = "";
  const notes = [
    "Deterministic source analysis. Source excerpts are evidence candidates, not verified legal conclusions.",
  ];
  switch (recipe) {
    case "parties": {
      columns = ["Name", "Role", "Location"];
      const selectedRole = (fields.role || config.value || "All roles").toLowerCase();
      for (const l of lines) {
        const labeled =
          /\b(Plaintiffs?|Defendants?|Witness(?:es)?|Deponent|Attorney|Counsel)\s*:\s*(.+)/i.exec(
            l.text,
          );
        const inline =
          /\b(plaintiff|defendant|witness|deponent)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){1,3})/gu;
        const found = labeled
          ? labeled[2]
              .split(/;|\s+and\s+|,(?!\s*(?:Inc|LLC|Ltd|Jr|Sr)\b)/)
              .map((name) => [labeled[1], name.trim()])
          : Array.from(l.text.matchAll(inline), (m) => [m[1], m[2]]);
        for (const [role, name] of found)
          if (
            name &&
            (selectedRole === "all roles" ||
              role.toLowerCase().includes(selectedRole.replace(/s$/, "")))
          )
            rows.push(
              evidence(
                l,
                {
                  Name: name.replace(/[.;]$/, ""),
                  Role: role,
                  Location: location(l),
                },
                "Found",
              ),
            );
      }
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const key = [
          r.cells.Name.toLowerCase(),
          r.cells.Role.toLowerCase().replace(/s$/, ""),
          r.sourceId || r.source,
        ].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      notes.push(
        "Extracts explicit role labels and role/name phrases. Caption-only names, aliases and implied roles need manual review; this cannot establish a complete party list.",
      );
      break;
    }
    case "chronology":
      columns = ["Date", "Event", "Date check"];
      for (const l of lines)
        for (const m of l.text.matchAll(dates))
          rows.push(
            evidence(l, {
              Date: m[0],
              Event: l.text,
              "Date check": m[0].includes("/")
                ? "Ambiguous numeric format — confirm locale"
                : /^\d{4}-/.test(m[0]) && !strictDate(m[0])
                  ? "Invalid calendar date — confirm source"
                  : "Source date — verify",
            }),
          );
      rows.sort((a, b) => dateKey(a.cells.Date).localeCompare(dateKey(b.cells.Date)));
      notes.push(
        "These dates are quoted from the source. No procedural deadline, service rule, holiday, or jurisdiction calculation is applied.",
      );
      break;
    case "issues": {
      columns = ["Issue", "Evidence", "Follow-up"];
      const terms = (
        fields.issues ||
        config.query ||
        "notice, warning, injury, knowledge, causation"
      )
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 25);
      for (const term of terms)
        for (const l of lines.filter((l) => matchesTerm(l.text, term)))
          rows.push(
            evidence(l, {
              Issue: term,
              Evidence: l.text,
              "Follow-up": "Confirm context in the complete document",
            }),
          );
      notes.push(
        "Matches your issue keywords. Does not determine credibility, causation, medical diagnosis, or whether testimony is contradictory.",
      );
      break;
    }
    case "requests": {
      columns = ["Request", "Response / objection", "Review point"];
      const requestLabel =
        /^\s*(?:\d{1,3}\s+)?(?:request(?: for production| for admission)?|interrogatory|RFP|RFA)\s*(?:no\.?|#)?\s*\d+/i;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!requestLabel.test(l.text)) continue;
        const follow: string[] = [];
        let endLine = l.line;
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (next.sourceId !== l.sourceId || requestLabel.test(next.text)) break;
          follow.push(next.text);
          endLine = next.line;
        }
        const response = follow.join(" ");
        rows.push(
          evidence(
            {
              ...l,
              endLine,
              text: files
                .find((f) => f.id === l.sourceId)!
                .text.split(/\r?\n/)
                .slice(l.line - 1, endLine)
                .join("\n"),
            },
            {
              Request: l.text,
              "Response / objection": response || "No adjacent response found",
              "Review point": /object|withhold|subject to/i.test(response)
                ? "Objection / withholding language"
                : "Confirm production completeness",
            },
            response ? "Review" : "Missing",
          ),
        );
      }
      notes.push(
        "Pairs a numbered request with the following block up to the next request or document boundary. Does not decide whether an objection is legally sufficient.",
      );
      break;
    }
    case "privilege":
      columns = ["Document", "Signal", "Reviewer", "Disposition"];
      for (const l of lines.filter((l) =>
        /attorney.client|work.product|privileg|legal advice/i.test(l.text),
      ))
        rows.push(
          evidence(l, {
            Document: l.source,
            Signal: l.text,
            Reviewer: fields.reviewer || "Assigned attorney",
            Disposition: "Unreviewed — no withholding decision",
          }),
        );
      notes.push(
        "Keyword screening is not a privilege determination. The queue may include negations or third-party references; review author, recipients, purpose and waiver.",
      );
      break;
    case "citations": {
      columns = ["Citation candidate", "Format findings", "Authority status"];
      for (const l of lines.filter((l) =>
        /\bv\.?\s|\bU\.S\.|\bF\.(?:2d|3d|4th|Supp)|§|\bId\./.test(l.text),
      )) {
        const findings: string[] = [];
        if (/\bv\.?\s/.test(l.text)) {
          if (!/\bv\.\s/.test(l.text)) findings.push("Check 'v.' punctuation");
          if (!/\d+\s+(?:U\.S\.|F\.[\w. ]+|S\.Ct\.|[A-Z][\w. ]{0,14})\s+\d/.test(l.text))
            findings.push("Check reporter / retrieval identifier");
          if (!/\([^)]*\b(?:18|19|20)\d{2}\)/.test(l.text))
            findings.push("Check year / court parenthetical (medium-neutral citations differ)");
          if (!/,\s*\d+(?:–\d+|-\d+)?\s*\(/.test(l.text))
            findings.push("Confirm a pinpoint where the proposition needs one");
        }
        if (/\bId\./.test(l.text))
          findings.push("Resolve short form against the preceding authority");
        if (/§/.test(l.text))
          findings.push("Verify code edition and section against current authority");
        rows.push(
          evidence(l, {
            "Citation candidate": l.text,
            "Format findings":
              findings.join("; ") || "Common components detected; manual check remains",
            "Authority status": "Not verified",
          }),
        );
      }
      notes.push(
        "Bluebook-oriented triage, not full Bluebook compliance or a citator. Plain-text extraction loses italics and footnote layout. No case existence, quotation accuracy, precedential status or subsequent history verification.",
      );
      break;
    }
    case "plain": {
      columns = ["Original", "Suggested wording", "Change"];
      const replacements: [[RegExp, string], ...Array<[RegExp, string]>] = [
        [/\bin order to\b/gi, "to"],
        [/\bat this point in time\b/gi, "now"],
        [/\bdue to the fact that\b/gi, "because"],
        [/\bin the event that\b/gi, "if"],
        [/\bprior to\b/gi, "before"],
        [/\bsubsequent to\b/gi, "after"],
        [/\butilize\b/gi, "use"],
        [/\bwith regard to\b/gi, "about"],
        [/\bfor the purpose of\b/gi, "to"],
      ];
      const edited = files
        .map((f) =>
          f.text
            .split(/\r?\n/)
            .map((line, i) => {
              if (/\bv\.\s|§|"|“|”|defined as|shall mean/i.test(line)) return line;
              let next = line;
              for (const [pattern, replacement] of replacements)
                next = next.replace(pattern, replacement);
              if (next !== line)
                rows.push(
                  evidence(
                    {
                      text: line,
                      source: f.name,
                      sourceId: f.id,
                      line: i + 1,
                      page: "",
                    },
                    {
                      Original: line,
                      "Suggested wording": next,
                      Change: "Phrase simplification",
                    },
                  ),
                );
              return next;
            })
            .join("\n"),
        )
        .join("\n\n");
      extra = `EDITED DRAFT\n${edited}\n\nCHANGE LOG\n`;
      notes.push(
        "Preserves lines containing quotes, citations, and explicit definitions. Only listed phrase substitutions are applied. Review meaning and tone; no authorship or AI-detector claims.",
      );
      break;
    }
    case "compare":
    case "changes":
      if (files.length < 2)
        throw new Error("Provide two source files: baseline first, then the updated version.");
      columns = ["Change", "Text"];
      rows = compareSources(files[0], files[1]);
      notes.push(
        "Compares normalized text lines, including repeated-line counts. Reordering and formatting alone are not reported. Semantic conflicts still need review.",
      );
      break;
    case "emails": {
      columns = ["Received", "From", "Subject", "Action excerpt"];
      for (const f of files) {
        const header = (k: string) =>
          new RegExp(`^${k}:\\s*(.*)$`, "im").exec(f.text)?.[1] || "Not provided";
        const date = header("Date"),
          after = fields.since ? Date.parse(`${fields.since}T00:00:00`) : NaN;
        if (Number.isFinite(after) && Number.isFinite(Date.parse(date)) && Date.parse(date) < after)
          continue;
        const ls = sourceLines([f]),
          action = ls.find(
            (l) =>
              /please|action:|by\b|follow.up|confirm|review|deadline/i.test(l.text) &&
              !/^(Subject|From|To|Date):/i.test(l.text),
          );
        const l = action || ls.find((l) => !/^(Subject|From|To|Date):/i.test(l.text)) || ls[0];
        if (l)
          rows.push(
            evidence(l, {
              Received: date,
              From: header("From"),
              Subject: header("Subject"),
              "Action excerpt": action?.text || "No explicit action found",
            }),
          );
      }
      rows.sort(
        (a, b) => (Date.parse(b.cells.Received) || 0) - (Date.parse(a.cells.Received) || 0),
      );
      notes.push(
        "Summarizes supplied email exports only. Date filter uses the browser's local midnight; undated messages remain for review. No inbox was accessed and no messages were sent.",
      );
      break;
    }
    case "actions":
      columns = ["Action / commitment", "Owner", "Due date"];
      for (const l of lines.filter((l) =>
        /\b(?:action|todo|to-do|please|will|must|follow.up|assigned|deadline)\b/i.test(l.text),
      ))
        rows.push(
          evidence(l, {
            "Action / commitment": l.text,
            Owner:
              /\b(?:owner|assigned to):\s*([^;]+)/i.exec(l.text)?.[1] ||
              "Not explicitly identified",
            "Due date": l.text.match(dates)?.join("; ") || "Not specified",
          }),
        );
      notes.push(
        "Only explicit wording is extracted. Owners and dates are not guessed; legal deadlines are not calculated.",
      );
      break;
    case "clauses": {
      columns = ["Clause topic", "Source language", "Review question"];
      const topics = (
        fields.issues ||
        config.query ||
        "indemnification, liability, termination, governing law, confidentiality, assignment"
      )
        .split(/[,\n]/)
        .map((t) => t.trim())
        .filter(Boolean);
      for (const topic of topics)
        for (const l of lines.filter((l) => matchesTerm(l.text, topic)))
          rows.push(
            evidence(l, {
              "Clause topic": topic,
              "Source language": l.text,
              "Review question":
                "Compare scope, exceptions and defined terms with the approved playbook",
            }),
          );
      notes.push(
        "Finds clause text by topic; it does not assign legal risk or decide enforceability. No missing clause is presumed present.",
      );
      break;
    }
    case "manifest":
      columns = ["File", "Characters", "Lines", "Suggested exhibit"];
      rows = files.map((f, i) =>
        evidence(
          {
            text: f.text.split(/\r?\n/)[0] || "",
            source: f.name,
            sourceId: f.id,
            line: 1,
            page: "",
          },
          {
            File: f.name,
            Characters: String(f.text.length),
            Lines: String(f.text.split("\n").length),
            "Suggested exhibit": `${fields.prefix || "EX"}-${String(i + 1).padStart(3, "0")}`,
          },
          "Found",
        ),
      );
      notes.push(
        "Exhibit numbers are suggestions in upload order; they are not applied to original files.",
      );
      break;
    case "fields": {
      const keys = (fields.columns || config.fields?.join(",") || "Plaintiffs, Date, Matter")
        .split(/[,\n]/)
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 20);
      columns = ["Field", "Value", "Match"];
      for (const key of keys) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          pattern = new RegExp(`(?:^|\\b)${escaped}:\\s*(.+)`, "i");
        for (const l of lines) {
          const m = pattern.exec(l.text);
          if (m)
            rows.push(evidence(l, { Field: key, Value: m[1], Match: "Explicit label" }, "Found"));
        }
      }
      notes.push(
        "Looks for Field: Value labels. Unlabeled or inferred values require a connected AI extraction step.",
      );
      break;
    }
    case "webbrief":
      columns = ["Source", "Excerpt", "Review"];
      for (const f of files)
        for (const l of sourceLines([f])
          .filter((l) => l.text.length > 55)
          .slice(0, 4))
          rows.push(
            evidence(l, {
              Source: f.name,
              Excerpt: l.text,
              Review: "Open original source and confirm currency",
            }),
          );
      notes.push(
        "An extractive reading brief, not an AI-generated legal answer. Search snippets and web pages can be incomplete or untrusted.",
      );
      break;
  }

  const report = makeReport(recipeNames[recipe], columns, rows, notes, extra, files);
  return {
    output: report,
    artifacts: [
      {
        name: `${recipeNames[recipe]}.csv`,
        format: "csv",
        content: reportCsv(report),
      },
    ],
  };
}
