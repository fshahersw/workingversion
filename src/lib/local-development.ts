/** Explicit, fail-closed local test lane. Never enabled merely by supplying a provider key. */
export type LocalEnvironment = Readonly<Record<string, string | undefined>>;

export function localSyntheticEnabled(env: LocalEnvironment = process.env): boolean {
  if (env.LOCAL_SYNTHETIC_MODE !== "1") return false;
  if (
    env.NODE_ENV === "production" ||
    (env.APP_ENVIRONMENT && env.APP_ENVIRONMENT !== "local") ||
    env.AWS_LAMBDA_FUNCTION_NAME ||
    env.AWS_EXECUTION_ENV ||
    env.ECS_CONTAINER_METADATA_URI ||
    env.ECS_CONTAINER_METADATA_URI_V4
  ) {
    throw new Error("LOCAL_SYNTHETIC_MODE is restricted to a local development process.");
  }
  return true;
}

export function assertLocalEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port || url.username || url.password || url.search || url.hash ||
    url.pathname !== "/"
  ) throw new Error("Local services require an explicit loopback HTTP origin and port.");
  return url.origin;
}

export function localServiceEndpoint(
  service: "dynamo" | "s3",
  env: LocalEnvironment = process.env,
): string | undefined {
  if (!localSyntheticEnabled(env)) return undefined;
  const name = service === "dynamo" ? "LOCAL_DYNAMO_ENDPOINT" : "LOCAL_S3_ENDPOINT";
  if (!env[name]) throw new Error(`${name} is required in local synthetic mode.`);
  return assertLocalEndpoint(env[name]);
}

export function localSyntheticRequest(request: Request, env: LocalEnvironment = process.env): boolean {
  if (!localSyntheticEnabled(env)) return false;
  const url = new URL(request.url);
  assertLocalEndpoint(url.origin);
  const origin = request.headers.get("origin");
  if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Cross-origin access to the local synthetic workspace is refused.");
  }
  return true;
}
