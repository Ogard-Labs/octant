import { pathToFileURL } from "node:url";

// The OS profile denies native sockets, children and host data. This bridge is
// only a request: the host independently validates phase, origin and approval.
const write = process.stdout.write.bind(process.stdout);
const send = (value) => write(`${JSON.stringify(value)}\n`);
console.log = console.info = console.warn = console.error = () => {};
let phase;
let fetchId = 0;
const waiting = new Map();
globalThis.fetch = async (input, init) => {
  if (phase !== "export" || fetchId >= 8) throw new Error("Network is unavailable.");
  const request = new Request(input, init);
  if (request.credentials === "include") throw new Error("Credentials are unavailable.");
  const id = ++fetchId;
  const body = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : Buffer.from(await request.arrayBuffer()).toString("base64");
  const response = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  send({
    kind: "fetch",
    id,
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    ...(body === undefined ? {} : { bodyBase64: body }),
  });
  return response;
};
let buffer = "";
let started = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 67_108_864) process.exit(1);
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.exit(1);
    }
    if (message.kind === "fetch-response") {
      const pending = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.failed) pending?.reject(new Error("Network request refused."));
      else
        pending?.resolve(
          new Response(
            [204, 205, 304].includes(message.status)
              ? null
              : Buffer.from(message.bodyBase64, "base64"),
            {
              status: message.status,
              headers: message.headers,
            },
          ),
        );
    } else if (
      !started &&
      message.protocol === "canvas-export/1" &&
      ["describe", "export"].includes(message.phase)
    ) {
      started = true;
      phase = message.phase;
      // Even module initialization is offline; only the export call gets the
      // mediated bridge, after importing this exact stored entry.
      const requestedPhase = phase;
      phase = "describe";
      import(pathToFileURL(process.argv[2]).href)
        .then(async (module) => {
          const target = module.canvasExport;
          phase = requestedPhase;
          if (phase === "describe") {
            const destination = await target.describeDestination?.(message.output);
            send({ kind: "description", ...(destination === undefined ? {} : { destination }) });
          } else
            send({
              kind: "delivery",
              delivery: await target.exportDocument(message.output, message.confirmed),
            });
        })
        .catch(() => send({ kind: "failed" }));
    } else process.exit(1);
  }
});
process.stdin.on("end", () => process.exit(0));
