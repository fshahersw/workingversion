/** Seeger Weiss desktop integration. No credentials or target identifiers belong here. */
export type WriterMode = 'write' | 'ask' | 'review' | 'research'
export type WriterProfile = 'standard' | 'thorough'
export interface WriterPreferences { swMode: WriterMode; swProfile: WriterProfile }
export interface WriterStatus {
  configured: boolean; researchConfigured: boolean; configPath: string;
  message: string; testedAt?: string; fixture?: boolean
}
// Platform integration: web_search is available in every mode (it runs through
// the platform's curated search), so the assistant can look facts up while it
// drafts instead of needing the separate public-research mode.
// Platform tools (src/office/shared/platform-skill.ts): sandboxed Python,
// citation checks, page reading, firm guides, diagrams and generated images
// change nothing in the document, so they are available in every mode;
// placing an image or creating a separate document is an edit.
const PLATFORM_READ = ['run_python', 'verify_citations', 'fetch_page', 'load_firm_guide', 'ask_clarification', 'render_diagram', 'generate_image']
const READ = ['get_document_context', 'read_blocks', 'read_revisions', 'read_comments', 'read_attachment', 'web_search', ...PLATFORM_READ]
const WRITE = [...READ, 'insert_content', 'replace_blocks', 'apply_commands', 'insert_chart', 'edit_chart', 'insert_image', 'set_header_footer', 'reply_comment', 'resolve_comment', 'create_document']
export function modeName(value: unknown): WriterMode {
  return value === 'ask' || value === 'review' || value === 'research' ? value : 'write'
}
export function profileName(value: unknown): WriterProfile { return value === 'thorough' ? 'thorough' : 'standard' }
export function publicPreferences(value: unknown): WriterPreferences {
  const x = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {swMode: modeName(x.swMode), swProfile: profileName(x.swProfile)}
}
export function allowedTools(mode: WriterMode): string[] {
  return mode === 'research' ? ['web_search'] : mode === 'write' ? [...WRITE] : [...READ]
}
export function filterTools<T extends {name: string}>(tools: T[], mode: WriterMode): T[] {
  const allowed = new Set(allowedTools(mode)); return tools.filter(t => allowed.has(t.name))
}
export function publicQuery(value: unknown): string {
  if(typeof value !== 'string') throw new Error('Enter a public research question.')
  const q=value.trim(); if(!q || q.length>200 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(q))
    throw new Error('The public research question must contain 1–200 characters.')
  return q
}
export function awsRegion(value: unknown): string {
  if(typeof value !== 'string' || !/^[a-z]{2}(?:-[a-z]+){1,2}-[1-9]$/.test(value))
    throw new Error('Set a valid approved AWS region in the connection configuration.')
  return value
}
export function gatewayUrl(value: unknown): URL {
  if(typeof value !== 'string')throw new Error('Configure the approved research gateway.')
  const u=new URL(value)
  if(u.protocol!=='https:' || u.username || u.password || u.port || u.search || u.hash || u.pathname!=='/mcp' ||
    !/^[a-z0-9][a-z0-9-]*\.gateway\.bedrock-agentcore\.[a-z]{2}(?:-[a-z]+){1,2}-[1-9]\.amazonaws\.com$/.test(u.hostname))
    throw new Error('Research requires the exact HTTPS AWS gateway /mcp endpoint. Redirects are not allowed.')
  return u
}
export function safeLink(value: unknown): string | null {
  if(typeof value!=='string' || value.length>8192)return null
  try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null}catch{return null}
}
export function writerError(error: unknown): string {
  const x=error as {name?:string;$metadata?:{httpStatusCode?:number}}
  if(x?.name==='AbortError')return 'The request was stopped.'
  if(x?.name==='CredentialsProviderError' || x?.name==='TokenProviderError')return 'AWS credentials are not available. Sign in to the approved AWS profile, then try again.'
  if(x?.name==='AccessDeniedException' || x?.$metadata?.httpStatusCode===403)return 'AWS denied this request. Check the approved account, permissions, and subscription.'
  if(x?.name==='ThrottlingException' || x?.$metadata?.httpStatusCode===429)return 'The writing service is busy. Wait briefly and try again.'
  if(x?.name==='ValidationException')return 'AWS rejected the configured request. Check the approved endpoint and request settings.'
  return 'The writing service could not complete the request. Check the connection settings and try again.'
}
