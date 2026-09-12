import type {
  EvidenceRow,
  ExecutionContext,
  ExecutionResult,
  SourceFile,
  StepConfig,
} from "./types";
import {
  evidence,
  makeReport,
  matchesTerm,
  reference,
  reportCsv,
  sourceFiles,
  sourceLines,
  strictDate,
  type SourceLine,
} from "./evidence.ts";
import { readRegister, moneyCents, formatMoney } from "./registers.ts";

export const practiceRecipeNames: Record<string, string> = {
  completeness: "Document completeness review",
  reconciliation: "Fact reconciliation",
  obligations: "Order & obligation register",
  register: "Operational register review",
  timeqc: "Common-benefit time review",
  settlementmath: "Settlement arithmetic worksheet",
  sourceqc: "Source bundle quality",
  testimony: "Deposition Q&A binder",
  exhibits: "Exhibit reference index",
  quotations: "Quotation verification",
  researchpacket: "Research source packet",
};
const unknown =
  /^(?:unknown|not (?:provided|known|available)|pending|tbd|missing|\[.*\]|[-–—])\.?$/i;
const list = (s: string) => [
  ...new Set(
    s
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];
const labelPattern = (key: string) =>
  new RegExp(
    `^\\s*(?:\\d+[.)]\\s*)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.*)$`,
    "i",
  );
const missingRow = (file: SourceFile, cells: Record<string, string>) =>
  evidence({ source: file.name, sourceId: file.id, line: 0, page: "", text: "" }, cells, "Missing");
const registerProfiles: Record<string, { required: string[]; key: string; date?: string }> = {
  case: {
    required: ["Matter", "Owner", "Status", "Next action", "Due date"],
    key: "Matter",
    date: "Due date",
  },
  medical: {
    required: ["Client ID", "Provider", "Requested", "Received", "Owner"],
    key: "Client ID",
    date: "Requested",
  },
  privilege: {
    required: ["Document ID", "Date", "Author", "Recipients", "Privilege basis", "Description"],
    key: "Document ID",
    date: "Date",
  },
  production: {
    required: ["Document ID", "Bates start", "Bates end", "Custodian", "Confidentiality"],
    key: "Document ID",
  },
  hold: {
    required: ["Custodian", "Notice date", "Acknowledged", "Owner"],
    key: "Custodian",
    date: "Notice date",
  },
  lien: {
    required: ["Client ID", "Lienholder", "Claimed amount", "Status", "Owner"],
    key: "Client ID",
  },
};
export function runPracticeRecipe(
  recipe: string,
  ctx: ExecutionContext,
  config: StepConfig,
): ExecutionResult {
  const files = sourceFiles(ctx);
  const fields = ctx.inputs.fields || {};
  const lines = sourceLines(files);
  const rows: EvidenceRow[] = [];
  let columns: string[] = [];
  const notes = [
    "Working paper for review. Local checks use explicit source text and supplied register fields; they do not decide legal sufficiency, case value or client eligibility.",
  ];
  if (config.instructions) notes.push(config.instructions);
  switch (recipe) {
    case "completeness": {
      columns = ["Document", "Required item", "Observed value", "Review action"];
      const keys = list(
        fields.requirements || config.fields?.join("\n") || "Matter, Client ID, Signature",
      );
      if (!keys.length || keys.length > 40)
        throw new Error("Supply between 1 and 40 required labels.");
      for (const file of files)
        for (const key of keys) {
          const hits = sourceLines([file])
            .map((l) => ({ l, m: labelPattern(key).exec(l.text) }))
            .filter((h) => h.m);
          if (!hits.length)
            rows.push(
              missingRow(file, {
                Document: file.name,
                "Required item": key,
                "Observed value": "Not found",
                "Review action":
                  "Locate the item in the original; absence of a label is not proof the item is missing.",
              }),
            );
          else {
            const values = new Set(hits.map((h) => h.m![1].trim().toLowerCase()));
            for (const { l, m } of hits) {
              const value = m![1].trim();
              const pending = !value || unknown.test(value);
              const qualified =
                /\b(pending|outstanding|awaiting|draft|unconfirmed|not received)\b/i.test(value) ||
                /^(?:none|n\/?a|not applicable)\.?$/i.test(value);
              rows.push(
                evidence(
                  l,
                  {
                    Document: file.name,
                    "Required item": key,
                    "Observed value": value || "Blank",
                    "Review action":
                      values.size > 1
                        ? "Conflicting repeated labels — reconcile with the source owner"
                        : pending
                          ? "Obtain or confirm the missing item"
                          : qualified
                            ? "Explicit qualification or negative answer — confirm status and applicability"
                            : "Confirm accuracy and any required supporting attachment",
                  },
                  pending ? "Missing" : values.size > 1 || qualified ? "Review" : "Found",
                ),
              );
            }
          }
        }
      notes.push(
        "Each document is checked separately. Uses exact Field: Value labels; it does not infer answers from narrative, validate a signature or substitute a generic checklist for a case-specific order.",
      );
      break;
    }
    case "reconciliation": {
      columns = ["Record identity", "Field", "Observed value", "Comparison"];
      const keys = list(
        fields.requirements || config.fields?.join("\n") || "Product, Exposure date, Injury",
      );
      const groupKey = fields.identity || "Client ID";
      const records = files.map((file) => {
        const ls = sourceLines([file]);
        const identities = ls
          .map((l) => labelPattern(groupKey).exec(l.text)?.[1]?.trim())
          .filter((s): s is string => !!s && !unknown.test(s));
        const identity = [...new Set(identities)];
        return { file, ls, id: identity.length === 1 ? identity[0] : null };
      });
      for (const record of records) {
        if (!record.id) {
          rows.push(
            missingRow(record.file, {
              "Record identity": "Unresolved",
              Field: groupKey,
              "Observed value": "Missing or conflicting identity",
              Comparison: "Excluded from cross-document comparison; confirm the record identity.",
            }),
          );
          continue;
        }
        for (const key of keys) {
          const related = records.filter((r) => r.id === record.id);
          const candidates = related.flatMap((r) =>
            r.ls
              .map((l) => ({
                l,
                value: labelPattern(key).exec(l.text)?.[1]?.trim(),
              }))
              .filter(
                (x): x is { l: SourceLine; value: string } => !!x.value && !unknown.test(x.value),
              ),
          );
          const unique = new Set(candidates.map((c) => c.value.toLowerCase().replace(/\s+/g, " ")));
          const own = candidates.filter((c) => c.l.sourceId === record.file.id);
          if (!own.length)
            rows.push(
              missingRow(record.file, {
                "Record identity": record.id,
                Field: key,
                "Observed value": "Not found",
                Comparison:
                  "Obtain the value from this document; other records are not silently substituted.",
              }),
            );
          for (const candidate of own) {
            const row = evidence(
              candidate.l,
              {
                "Record identity": record.id,
                Field: key,
                "Observed value": candidate.value,
                Comparison:
                  unique.size > 1
                    ? "Conflicting source values — reviewer decision required"
                    : related.length < 2
                      ? "Only one document for this identity"
                      : "No differing explicit value found",
              },
              unique.size > 1 ? "Review" : "Found",
            );
            row.references = candidates
              .filter((c) => c.l.sourceId !== record.file.id)
              .map((c) => reference(c.l));
            rows.push(row);
          }
        }
      }
      notes.push(
        "Grouping requires one explicit identity label per document. Values are compared as text; different wording may be equivalent. Separate records for different people are never combined.",
      );
      break;
    }
    case "obligations": {
      columns = ["Source obligation", "Express date / trigger", "Owner wording", "Review action"];
      for (const l of lines) {
        if (
          !/\b(shall|must|required|deadline|due|ordered|no later than|within \d+)\b/i.test(l.text)
        )
          continue;
        const dates =
          l.text.match(
            /\b\d{4}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/gi,
          ) || [];
        const relative = /\b(within|after|before|from|business days?|court days?)\b/i.test(l.text);
        rows.push(
          evidence(l, {
            "Source obligation": l.text,
            "Express date / trigger": dates.join("; ") || "Relative or unspecified — review source",
            "Owner wording":
              /\b(?:owner|assigned to):\s*([^;]+)/i.exec(l.text)?.[1] || "Not explicitly assigned",
            "Review action": relative
              ? "Confirm trigger, service, court rules, timezone and order; no date calculated"
              : dates.some((d) => d.includes("/") || (/^\d{4}-/.test(d) && !strictDate(d)))
                ? "Resolve ambiguous or invalid source date"
                : "Second-person verification before calendaring; identify who is bound",
          }),
        );
      }
      notes.push(
        "Extracts express obligation language, including exceptions or negations for review. Does not calculate deadlines, resolve superseding orders, send invitations or establish the governing jurisdiction.",
      );
      break;
    }
    case "register":
    case "timeqc":
    case "settlementmath": {
      const profile = recipe === "register" ? registerProfiles[config.value || "case"] : undefined;
      if (recipe === "register" && !profile)
        throw new Error("Choose a supported register profile.");
      const required =
        profile?.required ||
        (recipe === "timeqc"
          ? ["Date", "Timekeeper", "Matter", "Hours", "Task code", "Description"]
          : ["Client ID", "Gross", "Fees", "Expenses", "Liens"]);
      columns =
        recipe === "settlementmath"
          ? ["Record", "Gross", "Deductions", "Illustrative net", "Checks"]
          : recipe === "timeqc"
            ? ["Record", "Date", "Hours", "Task code", "Checks"]
            : ["Record", "Owner / author", "Status / classification", "Date / reference", "Checks"];
      const registers = files.map((file) => ({
        file,
        records: readRegister(file),
      }));
      const recordKey = (values: Record<string, string>) => {
        const v = (key: string) => values[key.toLowerCase()] || "";
        return JSON.stringify(
          profile
            ? [
                config.value,
                v(profile.key),
                config.value === "medical"
                  ? v("Provider")
                  : config.value === "lien"
                    ? v("Lienholder")
                    : "",
              ]
            : recipe === "timeqc"
              ? [v("Date"), v("Timekeeper"), v("Matter"), v("Hours"), v("Description")]
              : [v("Client ID")],
        );
      };
      const occurrences = new Map<string, number>();
      for (const { records } of registers) {
        for (const r of records) {
          const key = recordKey(r.values);
          occurrences.set(key, (occurrences.get(key) || 0) + 1);
        }
      }
      let netTotal = 0n;
      let accepted = 0;
      const daily = new Map<string, number>();
      for (const { file, records } of registers) {
        const headers = Object.keys(records[0].values);
        const missing = required.filter((key) => !headers.includes(key.toLowerCase()));
        if (missing.length)
          throw new Error(
            `${file.name}: missing columns ${missing.join(", ")}. Use the required column labels; column order does not matter.`,
          );
        for (const r of records) {
          const v = (key: string) => r.values[key.toLowerCase()] || "";
          const flags = required
            .filter((key) => !v(key) || unknown.test(v(key)))
            .map((key) => `${key}: missing or unresolved`);
          if ((occurrences.get(recordKey(r.values)) || 0) > 1)
            flags.push("Possible duplicate record; reconcile before using totals");
          const source = {
            text: r.excerpt,
            source: file.name,
            sourceId: file.id,
            line: r.line,
            endLine: r.endLine,
            page: "",
          };
          let cells: Record<string, string>;
          if (recipe === "timeqc") {
            const validHours = /^\d{1,2}(?:\.\d{1,2})?$/.test(v("Hours"));
            const hours = validHours ? Number(v("Hours")) : NaN;
            if (!validHours || hours <= 0 || hours > 24)
              flags.push("Hours must be a positive number no greater than 24");
            if (!strictDate(v("Date"))) flags.push("Date must be a real ISO date (YYYY-MM-DD)");
            const allowed = list(fields.codes || "");
            if (allowed.length && !allowed.includes(v("Task code")))
              flags.push("Task code is outside the supplied order-specific code list");
            if (
              /^(review|email|meeting|work|research|misc\.?|attention to matter)$/i.test(
                v("Description"),
              )
            )
              flags.push("Description lacks a specific work product or activity");
            if (/\b(and|then)\b|;/.test(v("Description")))
              flags.push("Review for multiple activities in a single entry");
            const day = [v("Date"), v("Timekeeper")].join("|");
            if (Number.isFinite(hours))
              daily.set(day, (daily.get(day) || 0) + Math.round(hours * 100));
            cells = {
              Record: `${v("Timekeeper")} · ${v("Matter")}`,
              Date: v("Date"),
              Hours: v("Hours"),
              "Task code": v("Task code"),
              Checks:
                flags.join("; ") ||
                "No mechanical flag; confirm compensability and the governing order",
            };
          } else if (recipe === "settlementmath") {
            const amounts = ["Gross", "Fees", "Expenses", "Liens"].map((k) => moneyCents(v(k)));
            if (amounts.some((a) => a === null))
              flags.push("Amounts must be nonnegative USD values with at most two decimal places");
            let deductions = "Not calculated",
              net = "Not calculated";
            if (amounts.every((a): a is bigint => a !== null)) {
              const sum = amounts[1] + amounts[2] + amounts[3];
              const value = amounts[0] - sum;
              deductions = formatMoney(sum);
              net = formatMoney(value);
              if (value < 0n) flags.push("Deductions exceed gross; resolve before approval");
              if (!flags.length) {
                netTotal += value;
                accepted++;
              }
            }
            cells = {
              Record: v("Client ID"),
              Gross: v("Gross"),
              Deductions: deductions,
              "Illustrative net": net,
              Checks: flags.join("; ") || "Arithmetic only — attorney and lien review required",
            };
          } else {
            if (profile!.date && !strictDate(v(profile!.date)))
              flags.push(`${profile!.date}: use a real ISO date; no locale guessed`);
            if (
              config.value === "hold" &&
              !/^(yes|acknowledged|received)$/i.test(v("Acknowledged"))
            )
              flags.push("Acknowledgment not confirmed");
            if (config.value === "medical" && !strictDate(v("Received")))
              flags.push(
                "Receipt date not confirmed; follow up without assuming records do not exist",
              );
            if (config.value === "production") {
              const a = /^(.+?)(\d+)$/.exec(v("Bates start"));
              const b = /^(.+?)(\d+)$/.exec(v("Bates end"));
              if (
                !a ||
                !b ||
                a[1] !== b[1] ||
                a[2].length !== b[2].length ||
                BigInt(a[2]) > BigInt(b[2])
              )
                flags.push("Bates range is inconsistent or reversed");
            }
            if (config.value === "lien" && moneyCents(v("Claimed amount")) === null)
              flags.push("Claimed amount is not a valid nonnegative USD value");
            if (
              config.value === "case" &&
              strictDate(fields.asof || "") &&
              strictDate(v("Due date")) &&
              v("Due date") < fields.asof &&
              !/^(complete|completed|closed|done)$/i.test(v("Status"))
            )
              flags.push("Open item precedes the selected as-of date; confirm current status");
            cells = {
              Record: v(profile!.key),
              "Owner / author": v("Owner") || v("Author") || v("Custodian") || "Not provided",
              "Status / classification":
                v("Status") ||
                v("Acknowledged") ||
                v("Privilege basis") ||
                v("Confidentiality") ||
                v("Received") ||
                "Not provided",
              "Date / reference": v(profile!.date || "Document ID") || v("Lienholder"),
              Checks: flags.join("; ") || "No mechanical flag; confirm against the source",
            };
          }
          rows.push(evidence(source, cells, flags.length ? "Review" : "Found"));
        }
      }
      if (recipe === "timeqc")
        for (const [key, hundredths] of daily)
          if (hundredths > 2400)
            notes.push(
              `${key}: daily entered hours total ${(hundredths / 100).toFixed(2)}, above 24. Duplicate entries are included in this diagnostic total.`,
            );
      if (recipe === "settlementmath")
        notes.push(
          `Illustrative net across ${accepted} rows without mechanical flags: ${formatMoney(netTotal)}. Flagged rows excluded; no fee entitlement, allocation, lien resolution or payment authorization is decided.`,
        );
      notes.push(
        "CSV/TSV mechanical checks preserve the original row and never alter the source register. Identical identifiers are flagged, not merged or deleted.",
      );
      break;
    }
    case "sourceqc": {
      columns = ["Document", "Read coverage", "Characters", "Checks"];
      const fingerprints = new Map<string, string>();
      for (const file of files) {
        const flags = [...(file.metadata?.warnings || [])];
        if (!file.text.trim()) flags.push("No readable text");
        const digest = file.metadata?.sha256 || file.text;
        if (fingerprints.has(digest))
          flags.push(
            `Duplicate ${file.metadata?.sha256 ? "file bytes" : "extracted text"} with ${fingerprints.get(digest)}; retain provenance until reviewer confirms`,
          );
        else fingerprints.set(digest, file.name);
        const first = sourceLines([file])[0] || {
          text: "",
          source: file.name,
          sourceId: file.id,
          line: 0,
          page: "",
        };
        rows.push(
          evidence(
            first,
            {
              Document: file.name,
              "Read coverage": file.metadata?.pages
                ? `${file.metadata.pages} PDF pages inspected`
                : "Text extraction; original layout not verified",
              Characters: String(file.text.length),
              Checks:
                flags.join("; ") ||
                "Readable text available; verify completeness against the original",
            },
            flags.length ? "Review" : "Found",
          ),
        );
      }
      notes.push(
        "Matching extracted text does not prove the original files are identical. The parser cannot establish medical completeness, authenticity or that a blank page contains no relevant image.",
      );
      break;
    }
    case "testimony": {
      columns = ["Topic", "Question", "Answer", "Follow-up"];
      const terms = list(fields.issues || config.query || "notice, warning, injury");
      for (const file of files) {
        const ls = sourceLines([file]);
        for (let i = 0; i < ls.length; i++) {
          if (!/^\s*(?:\d{1,3}\s+)?Q[.:]\s*/i.test(ls[i].text)) continue;
          const block = [ls[i]];
          let j = i + 1;
          while (j < ls.length && !/^\s*(?:\d{1,3}\s+)?Q[.:]\s*/i.test(ls[j].text)) {
            block.push(ls[j]);
            j++;
          }
          const answerIndex = block.findIndex((l) => /^\s*(?:\d{1,3}\s+)?A[.:]\s*/i.test(l.text));
          const content = block.map((l) => l.text).join("\n");
          const topics = terms.filter((term) => matchesTerm(content, term));
          if (!topics.length) continue;
          const raw = file.text
            .split(/\r?\n/)
            .slice(ls[i].line - 1, block.at(-1)!.line)
            .join("\n");
          rows.push(
            evidence(
              { ...ls[i], text: raw, endLine: block.at(-1)!.line },
              {
                Topic: topics.join("; "),
                Question: block
                  .slice(0, answerIndex < 0 ? block.length : answerIndex)
                  .map((l) => l.text)
                  .join("\n"),
                Answer:
                  answerIndex < 0
                    ? "No answer marker found"
                    : block
                        .slice(answerIndex)
                        .map((l) => l.text)
                        .join("\n"),
                "Follow-up": /\b(?:do not know|don't know|cannot recall|not sure|did not)\b/i.test(
                  content,
                )
                  ? "Qualification or uncertainty in context; retain complete testimony"
                  : "Keyword-selected Q&A; verify transcript page and printed line numbers",
              },
              answerIndex < 0 ? "Missing" : "Review",
            ),
          );
        }
      }
      notes.push(
        "Collects complete Q./A. blocks by topic terms, including objections and qualifications. Does not attribute an implied witness, resolve inconsistent testimony or decide credibility.",
      );
      break;
    }
    case "exhibits": {
      columns = ["Exhibit reference", "Context", "Source page", "Follow-up"];
      for (const l of lines)
        for (const m of l.text.matchAll(
          /\b(?:Exhibit|Ex\.)\s*(?:No\.?\s*)?([A-Z]?\d+(?:[A-Z]|-\d+)?|[A-Z])\b/g,
        ))
          rows.push(
            evidence(l, {
              "Exhibit reference": m[0],
              Context: l.text,
              "Source page": l.page || "Not identified",
              "Follow-up":
                "Locate the actual exhibit; a reference does not prove the exhibit is attached or admitted",
            }),
          );
      notes.push(
        "Lists every explicit exhibit reference, preserving repeated uses across documents. Does not renumber originals or infer admission status.",
      );
      break;
    }
    case "quotations": {
      if (files.length < 2)
        throw new Error(
          "Upload the draft first and at least one authority or source document after it.",
        );
      columns = ["Draft quotation", "Source comparison", "Review action"];
      const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
      for (const l of sourceLines([files[0]]))
        for (const m of l.text.matchAll(/[“"]([^”"\n]{20,})[”"]/g)) {
          const quote = m[1];
          const refs = files.slice(1).flatMap((f) =>
            sourceLines([f])
              .filter((s) => normalize(s.text).includes(normalize(quote)))
              .map(reference),
          );
          const row = evidence(
            l,
            {
              "Draft quotation": quote,
              "Source comparison": refs.length
                ? `Text match in ${new Set(refs.map((r) => r.sourceId)).size} supplied source(s)`
                : "No exact single-line match",
              "Review action": refs.length
                ? "Confirm surrounding context, cited authority and pinpoint; matching text does not establish authority validity"
                : "Check the original, line wrapping, ellipses, brackets and attribution; no fabrication finding is inferred",
            },
            refs.length ? "Found" : "Review",
          );
          row.references = refs;
          rows.push(row);
        }
      notes.push(
        "Checks quotations of at least 20 characters that begin and end on one extracted line. Whitespace is normalized; omissions, substitutions and multiline quotations require review. This is not a citator.",
      );
      break;
    }
    case "researchpacket": {
      columns = ["Research question", "Source excerpt", "Source reference", "Review action"];
      const terms = list(
        fields.issues || config.query || "discovery, preservation, plaintiff fact sheet",
      );
      for (const file of files) {
        const matches = sourceLines([file]).filter((l) =>
          terms.some((term) => matchesTerm(l.text, term)),
        );
        for (const l of matches)
          rows.push(
            evidence(l, {
              "Research question": fields.question || "Review the supplied issue list",
              "Source excerpt": l.text,
              "Source reference": file.name,
              "Review action":
                "Verify jurisdiction, effective date, binding weight and subsequent treatment using the original authority",
            }),
          );
        if (!matches.length)
          rows.push(
            missingRow(file, {
              "Research question": fields.question || "Supplied issue list",
              "Source excerpt": "No matching passage",
              "Source reference": file.name,
              "Review action":
                "Broaden the issue terms or add the relevant authority; no legal answer generated",
            }),
          );
      }
      notes.push(
        "Builds an issue-based reading packet from supplied sources. Search results are leads, not authorities. A connected research model must provide evidence anchors and distinguish binding from persuasive material.",
      );
      break;
    }
    default:
      throw new Error("Unsupported practice recipe.");
  }
  const report = makeReport(practiceRecipeNames[recipe], columns, rows, notes, "", files);
  return {
    output: report,
    artifacts: [
      {
        name: report.title + ".csv",
        format: "csv",
        content: reportCsv(report),
      },
    ],
  };
}
