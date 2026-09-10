export type EnvSource = Readonly<Record<string, string | undefined>>;

function runtimeEnv(): EnvSource {
  return typeof process === "undefined" ? {} : process.env;
}

export function isProductionEnv(env: EnvSource = runtimeEnv()): boolean {
  return env["NODE_ENV"] === "production";
}

export function requiredEnv(name: string, env: EnvSource = runtimeEnv()): string {
  const value = env[name];
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`Missing required environment variable: ${name}`);
}

export function envOrDevDefault(
  names: string | readonly string[],
  devDefault: string | (() => string),
  env: EnvSource = runtimeEnv(),
): string {
  const candidates = typeof names === "string" ? [names] : names;
  for (const name of candidates) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (isProductionEnv(env)) {
    throw new Error(`Missing required environment variable: ${candidates.join(" or ")}`);
  }
  return typeof devDefault === "function" ? devDefault() : devDefault;
}

export type CognitoConfig = {
  region: string;
  userPoolId: string;
  clientId: string;
  domain: string;
  redirectUri: string;
  logoutUri: string;
  issuer: string;
  secureCookies: boolean;
};

export function loadCognitoConfig(env: EnvSource = runtimeEnv()): CognitoConfig {
  const region = envOrDevDefault("COGNITO_REGION", "us-east-1", env);
  const userPoolId = envOrDevDefault("COGNITO_USER_POOL_ID", "us-east-1_D7NX6OyAR", env);
  const clientId = envOrDevDefault("COGNITO_CLIENT_ID", "3ab10qboajkm0vc36lcv59k78m", env);
  const domain = envOrDevDefault(
    "COGNITO_DOMAIN",
    "seegerweissai-auth.auth.us-east-1.amazoncognito.com",
    env,
  );
  const redirectUri = envOrDevDefault(
    "COGNITO_REDIRECT_URI",
    "http://localhost:8080/auth/callback",
    env,
  );
  const logoutUri = envOrDevDefault("COGNITO_LOGOUT_URI", "http://localhost:8080/", env);

  return {
    region,
    userPoolId,
    clientId,
    domain,
    redirectUri,
    logoutUri,
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    secureCookies: isProductionEnv(env) || redirectUri.startsWith("https://"),
  };
}

export function loadDynamoConfig(env: EnvSource = runtimeEnv()): {
  table: string;
  region: string;
} {
  return {
    table: envOrDevDefault("SW_DDB_TABLE", "sw-dev-app", env),
    region: envOrDevDefault("AWS_REGION", "us-east-1", env),
  };
}

export function loadS3Config(env: EnvSource = runtimeEnv()): {
  bucket: string;
  region: string;
} {
  return {
    bucket: envOrDevDefault("SW_S3_BUCKET", "sw-dev-seegerweissai-475976462949", env),
    region: envOrDevDefault("AWS_REGION", "us-east-1", env),
  };
}

export type KbConfig = {
  clusterArn: string;
  secretArn: string;
  database: string;
  region: string;
};

export function loadKbConfig(env: EnvSource = runtimeEnv()): KbConfig {
  return {
    clusterArn: envOrDevDefault("KB_CLUSTER_ARN", "", env),
    secretArn: envOrDevDefault("KB_SECRET_ARN", "", env),
    database: envOrDevDefault("KB_DATABASE", "", env),
    region: envOrDevDefault("AWS_REGION", "us-east-1", env),
  };
}

export type KbAsyncIngestConfig = {
  region: string;
  jobsTable: string;
  queueUrl: string;
  staleAfterSeconds: number;
  jobTtlDays: number;
};

function positiveInteger(name: string, fallback: number, env: EnvSource): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid positive integer environment variable: ${name}`);
  }
  return value;
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  env: EnvSource,
): number {
  const value = positiveInteger(name, fallback, env);
  if (value < minimum || value > maximum) {
    throw new Error(`Environment variable ${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/**
 * Async ingest is optional in local/test environments. Production fails closed
 * unless both dedicated-table and queue contracts are supplied explicitly.
 */
export function loadKbAsyncIngestConfig(env: EnvSource = runtimeEnv()): KbAsyncIngestConfig {
  const jobsTable = env["KB_INGEST_JOBS_TABLE"]?.trim() ?? "";
  const queueUrl = env["KB_INGEST_QUEUE_URL"]?.trim() ?? "";
  if (isProductionEnv(env)) {
    if (!jobsTable) requiredEnv("KB_INGEST_JOBS_TABLE", env);
    if (!queueUrl) requiredEnv("KB_INGEST_QUEUE_URL", env);
  }
  if (jobsTable && !/^[A-Za-z0-9_.-]{3,255}$/.test(jobsTable)) {
    throw new Error("KB_INGEST_JOBS_TABLE has an invalid table name");
  }
  if (queueUrl && !/^https:\/\/[^/\s]+\/[^\s]+$/.test(queueUrl)) {
    throw new Error("KB_INGEST_QUEUE_URL must be an HTTPS queue URL");
  }
  return {
    region: envOrDevDefault("AWS_REGION", "us-east-1", env),
    jobsTable,
    queueUrl,
    staleAfterSeconds: boundedInteger("KB_INGEST_STALE_AFTER_SECONDS", 900, 60, 86_400, env),
    jobTtlDays: boundedInteger("KB_INGEST_JOB_TTL_DAYS", 30, 7, 365, env),
  };
}

export function kbAsyncIngestConfigured(env: EnvSource = runtimeEnv()): boolean {
  const config = loadKbAsyncIngestConfig(env);
  return Boolean(config.jobsTable && config.queueUrl);
}

export function loadCorpusConfig(env: EnvSource = runtimeEnv()): {
  url: string;
  key: string;
} {
  return {
    url: envOrDevDefault(
      ["VITE_CORPUS_URL", "CORPUS_URL"],
      "https://odwhzepghulspdzmzhhz.supabase.co",
      env,
    ),
    key: envOrDevDefault(
      ["VITE_CORPUS_KEY", "CORPUS_KEY"],
      "sb_publishable_3dqNzUbWYPa27v_5oONvCw_iBx4yPiw",
      env,
    ),
  };
}

export type BdaConfig = {
  region: string;
  projectArn: string;
  profileArn: string;
};

export function loadBdaConfig(env: EnvSource = runtimeEnv()): BdaConfig {
  const region = envOrDevDefault(["BEDROCK_REGION", "AWS_REGION"], "us-east-1", env);
  const projectArn = envOrDevDefault(
    "BDA_PROJECT_ARN",
    "arn:aws:bedrock:us-east-1:475976462949:data-automation-project/7df322dd90ae",
    env,
  );
  const profileArn = envOrDevDefault(
    "BDA_PROFILE_ARN",
    () => {
      const accountId = envOrDevDefault("AWS_ACCOUNT_ID", "475976462949", env);
      return `arn:aws:bedrock:${region}:${accountId}:data-automation-profile/us.data-automation-v1`;
    },
    env,
  );
  return { region, projectArn, profileArn };
}

export function loadAgentCoreConfig(env: EnvSource = runtimeEnv()): {
  gatewayUrl: string;
  toolName: string;
  region: string;
} {
  return {
    gatewayUrl: envOrDevDefault(
      "AGENTCORE_SEARCH_URL",
      // App-owned gateway `agenticWebsearch` (was the Word add-in's shared
      // ClaudeAddinWebSearchIamGateway). Deployed envs override via param.
      "https://agenticwebsearch-kqnvc6gbhf.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
      env,
    ),
    toolName: envOrDevDefault("AGENTCORE_SEARCH_TOOL", "general___WebSearch", env),
    region: loadBedrockRegion(env),
  };
}

export function loadBedrockRegion(env: EnvSource = runtimeEnv()): string {
  return envOrDevDefault(["BEDROCK_REGION", "AWS_REGION"], "us-east-1", env);
}
