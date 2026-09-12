import { signedAwsFetch } from "../agents/bedrock-sign.server";
import { z } from "zod";
import { idSchema, WorkflowError, type Principal } from "./policy";

const attributesSchema = z.array(z.object({ Name: z.string(), Value: z.string().optional() }));
const listedSchema = z.object({
  Users: z
    .array(z.object({ Username: z.string(), Attributes: attributesSchema.optional() }))
    .default([]),
});
const accountSchema = z.object({
  Username: z.string(),
  Enabled: z.boolean(),
  UserAttributes: attributesSchema,
});
const groupsSchema = z.object({
  Groups: z.array(z.object({ GroupName: z.string() })).default([]),
  NextToken: z.string().optional(),
});

/** Background work rechecks current account status and groups, rather than retaining old JWT grants indefinitely. */
export async function refreshWorkerPrincipal(principal: Principal): Promise<Principal> {
  const pool = process.env.COGNITO_USER_POOL_ID;
  if (!pool) throw new WorkflowError(503, "The worker Cognito user pool is not configured.");
  idSchema.parse(principal.sub);
  const region = pool.split("_")[0];
  async function call(action: string, input: Record<string, unknown>): Promise<unknown> {
    const response = await signedAwsFetch(
      "cognito-idp",
      `https://cognito-idp.${region}.amazonaws.com/`,
      {
        region,
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
        },
        body: JSON.stringify({ UserPoolId: pool, ...input }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new WorkflowError(
        503,
        "The worker could not revalidate account access. Check Cognito permissions and availability.",
      );
    return response.json();
  }
  const listed = listedSchema.parse(
    await call("ListUsers", { Filter: `sub = "${principal.sub}"`, Limit: 2 }),
  );
  const matches = listed.Users.filter((u) =>
    u.Attributes?.some((a) => a.Name === "sub" && a.Value === principal.sub),
  );
  if (matches.length !== 1)
    throw new WorkflowError(403, "The account is no longer available for background work.");
  const account = accountSchema.parse(
    await call("AdminGetUser", { Username: matches[0].Username }),
  );
  const attributes = Object.fromEntries(account.UserAttributes.map((a) => [a.Name, a.Value]));
  if (account.Enabled !== true || attributes.sub !== principal.sub)
    throw new WorkflowError(403, "The account is disabled or no longer available.");
  const groups: string[] = [];
  let NextToken: string | undefined;
  do {
    const result = groupsSchema.parse(
      await call("AdminListGroupsForUser", {
        Username: account.Username,
        Limit: 60,
        ...(NextToken ? { NextToken } : {}),
      }),
    );
    groups.push(
      ...(result.Groups || [])
        .map((g) => g.GroupName)
        .filter((g: unknown) => typeof g === "string"),
    );
    NextToken = result.NextToken;
    if (groups.length > 300)
      throw new WorkflowError(403, "The account exceeds the workflow group limit.");
  } while (NextToken);
  return {
    ...principal,
    email: attributes.email_verified === "true" ? attributes.email || "" : "",
    name: attributes.name || principal.name,
    groups,
  };
}
