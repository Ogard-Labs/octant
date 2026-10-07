import { bunServe } from "./bunServe";

const server = await bunServe({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 4,
  fetch: (_request, facts) =>
    new Response(null, {
      status: 204,
      headers: {
        "x-octant-handler": "called",
        "x-octant-listener-trust": facts?.listenerTrust ?? "unknown",
        "x-octant-source-class": facts?.sourceClass ?? "unknown",
        "x-octant-source-key-length": String(facts?.sourceKey.length ?? 0),
      },
    }),
});

console.log(server.url.toString());

const stop = async () => {
  await server.stop(true);
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await new Promise(() => undefined);
