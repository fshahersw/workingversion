/** Seeger Weiss desktop integration. No credentials or target identifiers belong here. */
export type WriterMode = "write" | "ask" | "review" | "research";
export type WriterProfile = "standard" | "thorough";
export interface WriterPreferences {
  swMode: WriterMode;
  swProfile: WriterProfile;
}
export interface WriterStatus {
  configured: boolean;
  researchConfigured: boolean;
  configPath: string;
  message: string;
  testedAt?: string;
  fixture?: boolean;
}
// Platform tools (src/office/shared/platform-skill.ts) change nothing in the
// deck, so they are available in every mode; placing an image or creating a
// separate document is an edit. web_search runs through the platform.
// Mirrors src/lib/writer/inference.server.ts (the server enforces).
const PLATFORM_READ = [
  "run_python",
  "load_attachment_for_python",
  "verify_citations",
  "fetch_page",
  "load_firm_guide",
  "ask_clarification",
  "render_diagram",
  "get_diagram_source",
  "generate_image",
  "edit_image",
  "search_firm_knowledge",
  "search_library",
  "web_search",
  "image_search",
];
const READ = [
  "read_slide",
  "load_guide",
  "read_attachment",
  "list_slide_templates",
  "audit_layout",
  "list_style_templates",
  "view_slide",
  "list_templates",
  ...PLATFORM_READ,
];
const WRITE = [
  ...READ,
  "execute_slide_script",
  "add_slide",
  "edit_table_style",
  "edit_chart",
  "apply_ops",
  "design_slide_html",
  "save_style_template",
  "create_presentation",
  "insert_web_image",
  "replace_image",
  "create_document",
  "apply_template",
  "save_template",
];
const RESEARCH = [
  "web_search",
  "fetch_page",
  "search_firm_knowledge",
  "search_library",
  "verify_citations",
  "run_python",
  "load_attachment_for_python",
  "ask_clarification",
];
export function modeName(value: unknown): WriterMode {
  return value === "ask" || value === "review" || value === "research" ? value : "write";
}
export function profileName(value: unknown): WriterProfile {
  return value === "thorough" ? "thorough" : "standard";
}
export function publicPreferences(value: unknown): WriterPreferences {
  const x = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { swMode: modeName(x.swMode), swProfile: profileName(x.swProfile) };
}
export function allowedTools(mode: WriterMode): string[] {
  return mode === "research" ? [...RESEARCH] : mode === "write" ? [...WRITE] : [...READ];
}
export function filterTools<T extends { name: string }>(tools: T[], mode: WriterMode): T[] {
  const allowed = new Set(allowedTools(mode));
  return tools.filter((t) => allowed.has(t.name));
}
export function publicQuery(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a public research question.");
  const q = value.trim();
  // eslint-disable-next-line no-control-regex -- Intentionally reject control characters in public queries.
  if (!q || q.length > 200 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(q))
    throw new Error("The public research question must contain 1–200 characters.");
  return q;
}
export function awsRegion(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]{2}(?:-[a-z]+){1,2}-[1-9]$/.test(value))
    throw new Error("Set a valid approved AWS region in the connection configuration.");
  return value;
}
export function gatewayUrl(value: unknown): URL {
  if (typeof value !== "string") throw new Error("Configure the approved research gateway.");
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.search ||
    u.hash ||
    u.pathname !== "/mcp" ||
    !/^[a-z0-9][a-z0-9-]*\.gateway\.bedrock-agentcore\.[a-z]{2}(?:-[a-z]+){1,2}-[1-9]\.amazonaws\.com$/.test(
      u.hostname,
    )
  )
    throw new Error(
      "Research requires the exact HTTPS AWS gateway /mcp endpoint. Redirects are not allowed.",
    );
  return u;
}
export function safeLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
export function writerError(error: unknown): string {
  const x = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (x?.name === "AbortError") return "The request was stopped.";
  if (x?.name === "CredentialsProviderError" || x?.name === "TokenProviderError")
    return "AWS credentials are not available. Sign in to the approved AWS profile, then try again.";
  if (x?.name === "AccessDeniedException" || x?.$metadata?.httpStatusCode === 403)
    return "AWS denied this request. Check the approved account, permissions, and subscription.";
  if (x?.name === "ThrottlingException" || x?.$metadata?.httpStatusCode === 429)
    return "The writing service is busy. Wait briefly and try again.";
  if (x?.name === "ValidationException")
    return "AWS rejected the configured request. Check the approved endpoint and request settings.";
  return "The writing service could not complete the request. Check the connection settings and try again.";
}
