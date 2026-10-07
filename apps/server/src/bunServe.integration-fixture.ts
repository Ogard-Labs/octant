import { bunServe } from "./bunServe";

const server = await bunServe({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 4,
  fetch: async (request, facts) => {
    // A provider check that waits on a slow upstream answers after Bun's own
    // ten-second idle default, which would drop the connection first.
    if (new URL(request.url).pathname === "/slow") await Bun.sleep(12_000);
    return new Response(null, {
      status: 204,
      headers: {
        "x-octant-handler": "called",
        "x-octant-listener-trust": facts?.listenerTrust ?? "unknown",
        "x-octant-source-class": facts?.sourceClass ?? "unknown",
        "x-octant-source-key-length": String(facts?.sourceKey.length ?? 0),
      },
    });
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
