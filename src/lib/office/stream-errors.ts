/** Public, provider-independent failures. Never include upstream request bodies. */
export function officeStreamFailure(error: unknown, timedOut = false): { error: string; errorCode?: "timeout" | "overloaded" | "network" } {
  const status = Number((error as { status?: number } | null)?.status);
  const diagnostic = (error as { diagnostic?: { type?: string; message?: string } } | null)?.diagnostic;
  if (status === 400 && diagnostic?.type === "invalid_request_error" && /credit balance is too low/i.test(diagnostic.message ?? "")) return {
    error: "The local test model provider has insufficient API credits. Restore its credits or select a configured test provider, then resume after checking the document.",
  };
  if (timedOut || status === 408 || status === 504) return {
    error: "The writing service timed out. The task can be resumed after checking the document.", errorCode: "timeout",
  };
  if (status === 429 || status === 529) return {
    error: "The writing service is busy. Retrying may take a moment.", errorCode: "overloaded",
  };
  const network = error instanceof TypeError && /fetch|network|terminated/i.test(error.message);
  if (network || [500, 502, 503].includes(status)) return {
    error: "The writing service connection was interrupted. The task can be resumed after checking the document.", errorCode: "network",
  };
  return { error: "The writing service could not complete this request. Check the task status before continuing." };
}
