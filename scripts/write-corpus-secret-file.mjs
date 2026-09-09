import { existsSync, readFileSync, writeFileSync } from "node:fs";

function fromEnvFile() {
  if (!existsSync(".env")) return "";
  const text = readFileSync(".env", "utf8");
  const match = text.match(/^CORPUS_SERVICE_KEY=(.+)$/m);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : "";
}

const value = (process.env.CORPUS_SERVICE_KEY || "").trim() || fromEnvFile();
if (!value) {
  console.error("NO_CORPUS_SERVICE_KEY");
  process.exit(3);
}
writeFileSync(".tmp-corpus-secret.json", JSON.stringify({ CORPUS_SERVICE_KEY: value }));
console.log("SECRET_FILE_READY");
