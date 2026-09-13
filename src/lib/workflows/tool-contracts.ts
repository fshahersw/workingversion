import { z } from "zod";

/**
 * What each host tool a workflow may call actually reads.
 *
 * The adapter used to gate tool steps with a bare name allowlist and hand every
 * one of them the same `{ query, term, limit }` object. That works only because
 * the thirteen approved tools all happen to read one of those keys. Tools with a
 * real argument shape cannot be approved that way: `fda_search` wants an endpoint
 * and a search expression, and `db_graph_ask` wants a question, so both would
 * have been called with arguments they ignore and would fail inside the tool with
 * a message the workflow surfaces as a service error.
 *
 * Declaring the shape here fixes that and gives the Builder, and any plan
 * generator writing steps on a user's behalf, a machine-readable vocabulary: the
 * exact set of callable tools, which ones take a plain query, which ones need
 * structured arguments, and what those arguments must look like. Arguments are
 * validated before the tool runs, so a misconfigured step fails with a clear
 * message instead of a plausible-looking empty result.
 */
export type WorkflowToolContract = {
  /** Shown in the Builder, and offered to a plan generator as the tool's purpose. */
  label: string;
  /** Validated immediately before the tool is invoked. */
  args: z.ZodType<Record<string, unknown>>;
  /**
   * Build arguments from a single plain-language query string. Tools without this
   * require structured arguments, because there is no honest way to guess how a
   * sentence maps onto several required fields.
   */
  fromQuery?: (query: string) => Record<string, unknown>;
  /** Connector that must be configured for this tool, when it depends on one. */
  connection?: "docketbird";
};

/**
 * The shape the long-standing approved tools already receive. Every one of them
 * reads `query`, `term` or `limit`, so passing all three preserves the existing
 * behaviour exactly rather than guessing which key each one prefers.
 */
const QUERY_ARGS = z.object({
  query: z.string().min(1).max(2000),
  term: z.string().min(1).max(2000),
  limit: z.number().int().positive().max(50),
});

const fromQuery = (query: string) => ({ query, term: query, limit: 10 });

/** A query-driven search tool on the shared `{ query, term, limit }` shape. */
function querySearch(label: string, connection?: "docketbird"): WorkflowToolContract {
  return { label, args: QUERY_ARGS, fromQuery, connection };
}

export const WORKFLOW_TOOLS: Record<string, WorkflowToolContract> = {
  // Public and open-web research.
  web_search: querySearch("Search the public web"),
  search_pubmed: querySearch("Search PubMed for medical literature"),
  sec_search: querySearch("Search SEC filings"),
  federal_register_search: querySearch("Search the Federal Register"),
  ecfr_search: querySearch("Search the Code of Federal Regulations"),
  clinicaltrials_search: querySearch("Search ClinicalTrials.gov"),

  // Docket research. These need the DocketBird connector configured.
  db_search_filings: querySearch("Search docket filings", "docketbird"),
  db_get_case: querySearch("Read a case record", "docketbird"),
  db_docket_sheet: querySearch("Read a docket sheet", "docketbird"),
  db_find_case: querySearch("Find a case by name or number", "docketbird"),
  db_calendar: querySearch("Read docket calendar dates", "docketbird"),
  db_read_filing: querySearch("Read a filing document", "docketbird"),

  /**
   * Citation existence lookup. The adapter supplies the text from the step's own
   * source files rather than from a query, so there is no `fromQuery`.
   */
  verify_citations: {
    label: "Look up whether cited authorities exist",
    args: z.object({ text: z.string().min(1).max(40000) }),
  },

  /**
   * openFDA. Two required fields with no sensible single-string reading, so this
   * one is structured-arguments only. It was previously executable by the host
   * but absent from the allowlist, so a workflow could not reach it at all.
   */
  fda_search: {
    label: "Search openFDA (adverse events, recalls, labels)",
    args: z.object({
      endpoint: z.string().min(1).max(120),
      search: z.string().min(1).max(2000),
    }),
  },

  /**
   * Natural-language question over the docket graph. Reads `question`, not
   * `query`, which is why it could not simply be added to the old allowlist.
   */
  db_graph_ask: {
    label: "Ask a question across the docket graph",
    args: z.object({ question: z.string().min(5).max(2000) }),
    fromQuery: (query: string) => ({ question: query }),
    connection: "docketbird",
  },
};

/**
 * Tools deliberately left out, so the omissions are decisions rather than gaps:
 *
 * - `run_python` duplicates the engine's own `python` step, which runs in the
 *   isolated interpreter and reports its output as a first-class step result.
 * - `read_document` needs the caller to pass attachments, which a tool step does
 *   not have; workflows read documents through their own source files instead.
 * - `create_document` writes. Workflow output belongs to the run's evidence and
 *   report path, so exposing a second write route needs a policy decision first.
 * - `fetch_page` is reached through the adapter's dedicated fetch path, which
 *   applies the run's source policy; a bare tool call would bypass it.
 */
export const EXCLUDED_TOOLS = ["run_python", "read_document", "create_document", "fetch_page"];

/** Whether a tool may be called from a workflow step at all. */
export function isApprovedTool(name: string): boolean {
  return Object.hasOwn(WORKFLOW_TOOLS, name);
}

/** Tool names a Builder or plan generator may choose from. */
export function approvedToolNames(): string[] {
  return Object.keys(WORKFLOW_TOOLS);
}

export type ToolArgsSource = {
  /** A plain-language query, for tools that accept one. */
  query?: string;
  /** Structured arguments, already parsed from JSON. */
  json?: unknown;
};

export type ToolArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; status: 400; message: string };

/**
 * Build and validate the arguments for one tool call. Returns a failure rather
 * than throwing so the adapter keeps ownership of how workflow errors surface.
 */
export function buildToolArgs(name: string, source: ToolArgsSource): ToolArgsResult {
  const contract = WORKFLOW_TOOLS[name];
  if (!contract) {
    return { ok: false, status: 400, message: "This tool is not approved for workflow execution." };
  }

  let candidate: unknown;
  if (source.json !== undefined) {
    candidate = source.json;
  } else if (source.query !== undefined) {
    const query = source.query.trim();
    if (!query) {
      return { ok: false, status: 400, message: "Enter an explicit query of 1–2,000 characters." };
    }
    if (!contract.fromQuery) {
      return {
        ok: false,
        status: 400,
        message: `${contract.label} needs structured arguments. Supply a JSON object of tool arguments instead of a query.`,
      };
    }
    candidate = contract.fromQuery(query);
  } else {
    return { ok: false, status: 400, message: "This step is missing its tool arguments." };
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, status: 400, message: "Use a JSON object of tool arguments." };
  }

  const parsed = contract.args.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    return {
      ok: false,
      status: 400,
      message: field
        ? `${contract.label}: ${field} ${issue?.message ?? "is invalid"}.`
        : `${contract.label}: ${issue?.message ?? "arguments are invalid"}.`,
    };
  }
  return { ok: true, args: parsed.data };
}
