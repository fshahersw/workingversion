import { createServer } from "vite";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid test port");
// Exercise this checkout's real dev transforms without hot reload destroying
// an in-progress simulated outage. The regular development command is unchanged.
const server = await createServer({
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    hmr: false,
    watch: { ignored: ["**/.discovery.local/**", "**/.integration.local/**"] },
  },
});
await server.listen();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
