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
  DeleteObjectCommand,
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
    _s3 = new S3Client({ region });
    _s3Region = region;
  }
  return _s3;
}

/** Presigned URL for a direct browser PUT. No Content-Type is signed. */
export async function presignPut(key: string): Promise<string> {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: bucketName(), Key: key }),
    { expiresIn: PUT_TTL },
  );
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
