export type EnvSource = Readonly<Record<string, string | undefined>>;

function runtimeEnv(): EnvSource {
  return typeof process === "undefined" ? {} : process.env;
}

export function isProductionEnv(env: EnvSource = runtimeEnv()): boolean {
  return env["NODE_ENV"] === "production";
}

export function requiredEnv(
  name: string,
  env: EnvSource = runtimeEnv(),
): string {
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
    bucket: envOrDevDefault(
      "SW_S3_BUCKET",
      "sw-dev-seegerweissai-475976462949",
      env,
    ),
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
      "https://claudeaddinwebsearchiamgateway-x9d5bnlhd4.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
      env,
    ),
    toolName: envOrDevDefault("AGENTCORE_SEARCH_TOOL", "general___WebSearch", env),
    region: loadBedrockRegion(env),
  };
}

export function loadBedrockRegion(env: EnvSource = runtimeEnv()): string {
  return envOrDevDefault(["BEDROCK_REGION", "AWS_REGION"], "us-east-1", env);
}
