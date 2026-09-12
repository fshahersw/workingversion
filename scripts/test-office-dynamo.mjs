// A loopback-only protocol test. Dynalite is an optional, isolated test dependency:
// npm install --prefix .integration.local/dynamo dynalite@4.0.0 --ignore-scripts
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const require = createRequire(import.meta.url);
const dynalite = require("../.integration.local/dynamo/node_modules/dynalite");
const server = dynalite({ createTableMs: 0, deleteTableMs: 0 });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const child = spawn(
    process.versions.bun ? process.execPath : process.env.BUN_BIN || "bun",
    ["test", "tests/office-server/interpreter-dynamo.test.ts"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        OFFICE_DYNAMO_TEST_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
