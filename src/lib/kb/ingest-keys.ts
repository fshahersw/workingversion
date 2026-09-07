import { createHash } from "node:crypto";

import { isSha256 } from "./ingest-state.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRINCIPAL = /^[A-Za-z0-9+=,.@_-]{1,160}$/;
const JOB_LOOKUP = /^[A-Za-z0-9._:-]{1,256}$/;
const CLIENT_FILE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const INVOCATION_ARN =
  /^arn:(?:aws|aws-cn|aws-us-gov|aws-iso|aws-iso-b):bedrock:[a-z0-9-]+:[0-9]{12}:data-automation-invocation\/([A-Za-z0-9._:-]{1,256})$/;

function assertPrincipal(principal: string): void {
  if (!PRINCIPAL.test(principal)) throw new Error("invalid owner principal");
}

function assertSafeS3Key(key: string, allowTrailingSlash = false): void {
  const hasUnsafeCharacter = [...key].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || character === "\\";
  });
  if (
    !key ||
    key.length > 1024 ||
    hasUnsafeCharacter ||
    (!allowTrailingSlash && key.endsWith("/"))
  ) {
    throw new Error("invalid storage key");
  }
  const parts = key.split("/");
  if (allowTrailingSlash && parts.at(-1) === "") parts.pop();
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid storage key");
  }
}

export function requireOwnedUploadKey(principal: string, key: string): string {
  assertPrincipal(principal);
  assertSafeS3Key(key);
  if (!key.startsWith(`uploads/${principal}/`)) {
    throw new Error("input object is not owned by the principal");
  }
  return key;
}

export function bdaOutputPrefix(principal: string, docId: string): string {
  assertPrincipal(principal);
  if (!UUID.test(docId)) throw new Error("invalid document id");
  return `kb/bda-output/${principal}/${docId}/`;
}

export function requireClientFileId(value: string): string {
  if (!CLIENT_FILE_ID.test(value)) throw new Error("invalid client file id");
  return value;
}

export function requireOwnedBdaOutputPrefix(
  principal: string,
  docId: string,
  prefix: string,
): string {
  assertSafeS3Key(prefix, true);
  if (prefix !== bdaOutputPrefix(principal, docId)) {
    throw new Error("invalid BDA output prefix");
  }
  return prefix;
}

export function requireOwnedBdaResultUri(args: {
  uri: string;
  bucket: string;
  principal: string;
  docId: string;
  outputPrefix: string;
}): string {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(args.uri);
  if (!match || match[1] !== args.bucket) {
    throw new Error("invalid BDA result location");
  }
  const expected = requireOwnedBdaOutputPrefix(args.principal, args.docId, args.outputPrefix);
  const key = match[2]!;
  assertSafeS3Key(key);
  if (!key.startsWith(expected)) {
    throw new Error("invalid BDA result location");
  }
  return key;
}

function addField(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, "utf8")));
  hash.update(":");
  hash.update(value);
  hash.update("|");
}

/** BDA accepts this stable token on every retry of the same owned file. */
export function deterministicBdaClientToken(args: {
  principal: string;
  workspaceItemId: string;
  workspaceId: string;
  clientFileId: string;
  sha256: string;
}): string {
  assertPrincipal(args.principal);
  if (!UUID.test(args.workspaceItemId) || !UUID.test(args.workspaceId)) {
    throw new Error("invalid workspace id");
  }
  requireClientFileId(args.clientFileId);
  if (!isSha256(args.sha256)) throw new Error("invalid file hash");
  const hash = createHash("sha256");
  addField(hash, args.principal);
  addField(hash, args.workspaceItemId.toLowerCase());
  addField(hash, args.workspaceId.toLowerCase());
  addField(hash, args.clientFileId);
  addField(hash, args.sha256.toLowerCase());
  return `kb-${hash.digest("hex")}`;
}

export function requireJobLookupId(value: string): string {
  if (!JOB_LOOKUP.test(value)) throw new Error("invalid ingest job id");
  return value;
}

export function invocationJobId(invocationArn: string): string {
  const match = INVOCATION_ARN.exec(invocationArn);
  if (!match) throw new Error("invalid BDA invocation");
  return requireJobLookupId(match[1]!);
}
