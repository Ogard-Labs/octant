import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunServe } from "../bunServe";

// Serves the listener's two certificates through Bun, from the folder the test
// wrote them to, and prints the address it bound.
const directory = process.argv[2] ?? "";
const read = (name: string) => readFileSync(join(directory, name), "utf8");

const server = await bunServe({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 1_024,
  fetch: () => new Response(null, { status: 204 }),
  tls: { cert: read("own.crt"), key: read("own.key") },
  tailnetTls: {
    cert: read("tailnet.crt"),
    key: read("tailnet.key"),
    serverName: read("tailnet.name").trim(),
  },
});

console.log(server.url.toString());

const stop = async () => {
  await server.stop(true);
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await new Promise(() => undefined);
