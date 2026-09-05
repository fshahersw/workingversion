// Direct integration test of the uploads layer against the live
// sw-dev-seegerweissai bucket + sw-dev-app table (bypasses server-fn/auth;
// uses a throwaway test principal). Exercises the full presigned round-trip.
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 bun run scripts/test-uploads.ts
import {
  createUpload,
  registerUpload,
  getDownloadUrl,
  listItems,
  deleteLibraryItem,
} from "../src/lib/library/library.server";

const P = `test-principal-${Date.now()}`;
const BODY = `hello seegerweiss ${Date.now()}`;

async function main() {
  const name = "test-note.txt";

  // 1. Reserve item + presigned PUT.
  const up = await createUpload(P, { name, size: BODY.length });
  console.log("createUpload -> itemId:", up.itemId, "| key:", up.s3Key);

  // 2. Upload the bytes straight to S3.
  const put = await fetch(up.uploadUrl, {
    method: "PUT",
    body: new Uint8Array(Buffer.from(BODY, "utf8")),
  });
  console.log("PUT to S3 ->", put.status, put.ok ? "OK" : "FAILED");
  if (!put.ok) throw new Error(`presigned PUT failed: ${put.status} ${await put.text()}`);

  // 3. Record the file item.
  await registerUpload(P, {
    itemId: up.itemId,
    s3Key: up.s3Key,
    name,
    contentType: "text/plain",
    size: BODY.length,
  });
  console.log("registerUpload -> ok");

  // 4. It shows up in the file listing.
  const files = await listItems(P, "file");
  const found = files.find((f) => f.itemId === up.itemId);
  console.log("listItems(file):", files.length, "| found this one:", !!found, "| size:", found?.size);

  // 5. Presigned download returns the exact bytes.
  const { url } = await getDownloadUrl(P, up.itemId);
  const get = await fetch(url);
  const text = await get.text();
  console.log("GET download ->", get.status, "| body matches:", text === BODY);
  if (text !== BODY) throw new Error("downloaded body did not match uploaded body");

  // 6. Delete removes both the blob and the metadata.
  await deleteLibraryItem(P, up.itemId);
  const after = await fetch(url);
  console.log("after delete, GET ->", after.status, "(expect 403/404)");
  const stillListed = (await listItems(P, "file")).some((f) => f.itemId === up.itemId);
  console.log("still listed after delete:", stillListed, "(expect false)");
  if (after.ok || stillListed) throw new Error("delete did not fully clean up");

  console.log("\nUPLOADS TEST PASSED for principal", P);
}

main().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
