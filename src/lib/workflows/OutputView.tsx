import { AnswerMarkdown } from "@/components/chat/AnswerMarkdown";
import { isAnalysisReport } from "./recipes";
import { displayValue } from "./engine";
import { ReportView } from "./ReportView";
import type { Artifact } from "./types";

/** Text carried by a step output, if any. Grounded analysis reports also carry a
 *  `text`, so callers must check isAnalysisReport first (done below). */
function outputText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && typeof (output as { text?: unknown }).text === "string")
    return (output as { text: string }).text;
  return null;
}

/**
 * One presenter for every workflow step / run result, shared by the builder run
 * panel and the Mini App surface. Structured evidence renders in the full
 * ReportView (tables, source-peek, export); prose renders as formatted markdown
 * via the chat renderer instead of a raw JSON dump; anything else falls back to
 * JSON. An object that carries prose keeps a collapsed "raw output" escape hatch
 * so the structured extras (evidence, model, usage) stay inspectable.
 */
export function OutputView({
  output,
  artifacts = [],
}: {
  output: unknown;
  artifacts?: Artifact[];
}) {
  if (isAnalysisReport(output)) return <ReportView report={output} artifacts={artifacts} />;

  const text = outputText(output);
  if (text !== null) {
    const hasExtras = typeof output === "object" && output !== null;
    return (
      <div className="swf-output-md">
        <AnswerMarkdown text={text} onCite={() => {}} streaming={false} />
        {hasExtras && (
          <details className="swf-output-raw">
            <summary>View raw output</summary>
            <pre className="swf-result-json">{displayValue(output)}</pre>
          </details>
        )}
      </div>
    );
  }

  return <pre className="swf-result-json">{displayValue(output)}</pre>;
}
