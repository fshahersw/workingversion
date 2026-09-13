// S3 helpers for the SeegerWeissAI storage layer (user uploads, saved blobs).
// Server-only. Uses the default AWS credential chain (SSO profile in dev; a
// scoped role in prod) and AWS_REGION. Bucket from SW_S3_BUCKET.
//
// Uploads use presigned PUT URLs so file bytes go browser -> S3 directly and
// never transit the app server. We intentionally do NOT sign a Content-Type on
// the PUT (avoids SigV4 signed-header mismatch); the bucket's default SSE-KMS
// encrypts the object server-side automatically. Downloads use a presigned GET
// with an attachment disposition and the stored content type.
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadS3Config } from "../config.server";

const PUT_TTL = 900; // 15 min to start an upload
const GET_TTL = 300; // 5 min download link

let _s3: S3Client | undefined;
let _s3Region = "";

export function bucketName(): string {
  return loadS3Config().bucket;
}

export function s3(): S3Client {
  const { region } = loadS3Config();
  if (!_s3 || _s3Region !== region) {
    // requestChecksumCalculation: "WHEN_REQUIRED" is REQUIRED for browser
    // presigned PUTs. aws-sdk-js-v3 >= 3.729 defaults to "WHEN_SUPPORTED",
    // which injects a default (CRC32) checksum the browser fetch cannot supply,
    // breaking every presigned upload (deposition originals, Working Set,
    // Office attachments). The explicit ChecksumSHA256 we sign for integrity is
    // still honored under WHEN_REQUIRED.
    _s3 = new S3Client({ region, requestChecksumCalculation: "WHEN_REQUIRED" });
    _s3Region = region;
  }
  return _s3;
}

/** Presigned URL for a direct browser PUT. Content-Type remains unsigned; an
 * optional SHA-256 checksum header is signed for async-ingest integrity.
 *
 * The checksum MUST stay a signed HEADER (not a hoisted query parameter). The
 * presigner hoists unlisted headers into the query string by default; S3 then
 * (a) rejects the browser's `x-amz-checksum-sha256` header as unsigned (403
 * HeadersNotSigned), and (b) does not enforce or store a query-only checksum,
 * so a tampered body is accepted and verifyUploadedObject can never match.
 * Probed live 2026-09-12; both failure modes reproduced. */
export async function presignPut(key: string, checksumSha256?: string): Promise<string> {
  const checksumHeader = "x-amz-checksum-sha256";
  return getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      ...(checksumSha256 ? { ChecksumSHA256: checksumSha256 } : {}),
    }),
    {
      expiresIn: PUT_TTL,
      ...(checksumSha256
        ? {
            signableHeaders: new Set([checksumHeader]),
            unhoistableHeaders: new Set([checksumHeader]),
          }
        : {}),
    },
  );
}

/**
 * Verify an async upload without reading its body. The presigned PUT binds the
 * checksum header, and S3 validates/stores that checksum before this HEAD call.
 */
export async function verifyUploadedObject(
  key: string,
  expectedSize: number,
  expectedSha256Hex: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(expectedSha256Hex)) {
    throw new Error("invalid expected object checksum");
  }
  const expectedChecksumSha256 = Buffer.from(expectedSha256Hex, "hex").toString("base64");
  const result = await s3().send(
    new HeadObjectCommand({
      Bucket: bucketName(),
      Key: key,
      ChecksumMode: "ENABLED",
    }),
  );
  if (result.ContentLength !== expectedSize || result.ChecksumSHA256 !== expectedChecksumSha256) {
    const error = new Error("uploaded object integrity check failed");
    error.name = "ObjectIntegrityError";
    throw error;
  }
}

/** Presigned URL to download an object as an attachment with a clean filename. */
export async function presignGet(
  key: string,
  filename?: string,
  contentType?: string,
): Promise<string> {
  const safe = (filename ?? "download").replace(/["\r\n\\]/g, "_").slice(0, 200);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safe}"`,
      ...(contentType ? { ResponseContentType: contentType } : {}),
    }),
    { expiresIn: GET_TTL },
  );
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}

/** Delete every object under an already ownership-validated prefix. */
export async function deletePrefix(prefix: string): Promise<number> {
  if (!prefix || !prefix.endsWith("/") || prefix.includes("..")) {
    throw new Error("invalid object prefix");
  }
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const listed = await s3().send(
      new ListObjectsV2Command({
        Bucket: bucketName(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    const keys = (listed.Contents ?? []).flatMap((object) =>
      object.Key ? [{ Key: object.Key }] : [],
    );
    if (keys.length) {
      const response = await s3().send(
        new DeleteObjectsCommand({
          Bucket: bucketName(),
          Delete: { Objects: keys, Quiet: true },
        }),
      );
      if (response.Errors?.length) {
        throw new Error("one or more prefix objects could not be deleted");
      }
      deleted += keys.length;
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}
