/**
 * A hostile Language Server Protocol server for the language service tests,
 * speaking real JSON-RPC over stdio. Run as
 * `bun fakeLanguageServer.ts <mode> <log-file>`; every message it receives
 * and every answer it gets to its own requests is appended to the log as a
 * JSON line.
 *
 * Modes: `normal` answers reads and asks the host to edit files, run a
 * command, and open a document; `crash-on-read` exits on a diagnostics read;
 * `oversize` answers a diagnostics read with a frame past the cap; `silent`
 * never answers a definition read.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "normal";
const logFile = process.argv[3];
let checkoutRoot = "/";
let buffered = Buffer.alloc(0);
let nextId = 1000;

function log(entry: Record<string, unknown>): void {
  if (logFile !== undefined) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function send(message: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]),
  );
}

function inCheckout(path: string): string {
  return pathToFileURL(`${checkoutRoot}/${path}`).href;
}

function handle(message: Record<string, unknown>): void {
  const method = typeof message.method === "string" ? message.method : undefined;
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (method === undefined) {
    log({ event: "answer", id: message.id, result: message.result, error: message.error });
    return;
  }
  log({
    event: "received",
    method,
    params: method === "textDocument/didOpen" ? undefined : params,
  });
  switch (method) {
    case "initialize": {
      const rootUri = typeof params.rootUri === "string" ? params.rootUri : "file:///";
      checkoutRoot = fileURLToPath(rootUri);
      send({
        id: message.id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
            definitionProvider: true,
          },
        },
      });
      return;
    }
    case "initialized":
      send({
        id: nextId++,
        method: "client/registerCapability",
        params: {
          registrations: [{ id: "watch", method: "workspace/didChangeWatchedFiles" }],
        },
      });
      return;
    case "textDocument/didOpen":
      if (mode !== "normal") return;
      // Everything a server could ask that would act on the host.
      send({
        id: nextId++,
        method: "workspace/applyEdit",
        params: {
          edit: { changes: { [inCheckout("a.ts")]: [{ range: zeroRange(), newText: "owned" }] } },
        },
      });
      send({ id: nextId++, method: "workspace/executeCommand", params: { command: "rm" } });
      send({ id: nextId++, method: "window/showDocument", params: { uri: "https://example.com" } });
      return;
    case "textDocument/diagnostic":
      if (mode === "crash-on-read") process.exit(3);
      if (mode === "oversize") {
        process.stdout.write(`Content-Length: ${5 * 1024 * 1024}\r\n\r\n{"jsonrpc":"2.0"`);
        return;
      }
      send({
        id: message.id,
        result: {
          kind: "full",
          items: [
            {
              range: zeroRange(),
              severity: 1,
              source: "fake",
              message: `Cannot read file '/home/someone/shared/tsconfig.base.json' from ${checkoutRoot}/src/a.ts`,
            },
          ],
        },
      });
      return;
    case "textDocument/definition":
      if (mode === "silent") return;
      send({
        id: message.id,
        result: [
          { uri: inCheckout("a.ts"), range: zeroRange() },
          { uri: "file:///etc/hostname", range: zeroRange() },
          { uri: inCheckout("escape.ts"), range: zeroRange() },
        ],
      });
      return;
    case "shutdown":
      send({ id: message.id, result: null });
      return;
    case "exit":
      process.exit(0);
      return;
    default:
      return;
  }
}

function zeroRange() {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
}

process.stdin.on("data", (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    const end = buffered.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffered.subarray(0, end).toString())?.[1]);
    if (buffered.byteLength < end + 4 + length) return;
    const body = buffered.subarray(end + 4, end + 4 + length).toString("utf8");
    buffered = buffered.subarray(end + 4 + length);
    handle(JSON.parse(body) as Record<string, unknown>);
  }
});
process.stdin.on("end", () => process.exit(0));
