/**
 * A Debug Adapter Protocol adapter written for the debug session tests, and
 * the program it debugs. The adapter is a `#!` script on the runtime that
 * runs the tests, so a package can ship it as its only executable file; it
 * speaks real DAP on stdio and launches the program as its own child, as a
 * real adapter does.
 *
 * The program is plain JavaScript that reports each checkpoint (a line and
 * its locals) to the adapter over an extra pipe and waits to be resumed, so
 * the adapter can stop it at a breakpoint, step it, show its stack and
 * variables, and continue it. Its last checkpoint carries what it tried to do
 * outside its confinement.
 *
 * Modes: `normal`; `reverse-requests` asks the host to run a terminal and to
 * start a second session before it answers `launch`; `oversize` answers a
 * `threads` request with a frame past the host's cap.
 */

export type FakeDebugAdapterMode = "normal" | "reverse-requests" | "oversize";

export function fakeDebugAdapterScript(mode: FakeDebugAdapterMode = "normal"): string {
  return `#!${process.execPath}
"use strict";
const { spawn } = require("node:child_process");
const MODE = ${JSON.stringify(mode)};
let buffered = Buffer.alloc(0);
let seq = 1;
let launchArgs = {};
const breakpoints = new Map();
let program;
let control;
let resume;
let stepping = false;
let locals = {};
let line = 0;

function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
}
function respond(request, body, success = true, message) {
  send({ type: "response", request_seq: request.seq, command: request.command, success, ...(body === undefined ? {} : { body }), ...(message === undefined ? {} : { message }) });
}
function event(name, body) {
  send({ type: "event", event: name, ...(body === undefined ? {} : { body }) });
}

function startProgram() {
  program = spawn(process.execPath, [launchArgs.program, ...(launchArgs.args || [])], {
    cwd: launchArgs.cwd,
    env: { ...process.env, ...(launchArgs.env || {}) },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  program.stdout.on("data", (chunk) => event("output", { category: "stdout", output: chunk.toString("utf8") }));
  program.stderr.on("data", (chunk) => event("output", { category: "stderr", output: chunk.toString("utf8") }));
  event("output", { category: "telemetry", output: "adapter telemetry" });
  control = program.stdio[3];
  let pending = "";
  control.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    while (pending.includes("\\n")) {
      const at = pending.indexOf("\\n");
      const checkpoint = JSON.parse(pending.slice(0, at));
      pending = pending.slice(at + 1);
      line = checkpoint.line;
      locals = checkpoint.locals;
      const lines = breakpoints.get(launchArgs.program) || new Set();
      const stopOnEntry = launchArgs.stopOnEntry === true && checkpoint.first === true;
      if (stepping || lines.has(line) || stopOnEntry) {
        const reason = stepping ? "step" : stopOnEntry ? "entry" : "breakpoint";
        stepping = false;
        resume = () => control.write("go\\n");
        event("stopped", { reason, threadId: 1, allThreadsStopped: true, description: "Paused in " + launchArgs.program });
      } else {
        control.write("go\\n");
      }
    }
  });
  program.on("exit", (code) => {
    event("exited", { exitCode: code === null ? 1 : code });
    event("terminated");
  });
}

function variablesOf(value, base) {
  return Object.entries(value).map(([name, item], index) => ({
    name,
    value: typeof item === "object" && item !== null ? "{...}" : String(item),
    type: typeof item,
    variablesReference: typeof item === "object" && item !== null ? base + index + 1 : 0,
  }));
}

function handle(request) {
  const args = request.arguments || {};
  switch (request.command) {
    case "initialize":
      respond(request, {
        supportsConfigurationDoneRequest: true,
        exceptionBreakpointFilters: [{ filter: "raised", label: "Raised exceptions", default: false }],
      });
      event("initialized");
      return;
    case "launch":
      launchArgs = args;
      if (MODE === "reverse-requests") {
        send({ type: "request", command: "runInTerminal", arguments: { kind: "integrated", cwd: "/", args: ["/bin/sh", "-c", "touch /tmp/ran-in-terminal"] } });
        send({ type: "request", command: "startDebugging", arguments: { request: "launch", configuration: { program: "/bin/sh" } } });
      }
      respond(request);
      return;
    case "setBreakpoints": {
      const lines = (args.breakpoints || []).map((breakpoint) => breakpoint.line);
      breakpoints.set(args.source.path, new Set(lines));
      respond(request, { breakpoints: lines.map((value) => ({ verified: true, line: value })) });
      return;
    }
    case "setExceptionBreakpoints":
      respond(request, {});
      return;
    case "configurationDone":
      respond(request);
      startProgram();
      return;
    case "threads":
      if (MODE === "oversize") {
        process.stdout.write("Content-Length: " + String(5 * 1024 * 1024) + "\\r\\n\\r\\n");
        return;
      }
      respond(request, { threads: [{ id: 1, name: "main" }] });
      return;
    case "stackTrace":
      respond(request, {
        stackFrames: [
          { id: 1, name: "main (" + launchArgs.program + ")", source: { path: launchArgs.program }, line, column: 1 },
          { id: 2, name: "internal runner", source: { path: "/usr/lib/runtime/internal.js" }, line: 10, column: 3 },
          { id: 3, name: "generated", source: { name: "generated", sourceReference: 7 }, line: 1, column: 1 },
        ],
        totalFrames: 3,
      });
      return;
    case "scopes":
      respond(request, { scopes: [{ name: "Locals", variablesReference: 1000, expensive: false }] });
      return;
    case "variables": {
      if (args.variablesReference === 1000) {
        respond(request, { variables: variablesOf(locals, 1000) });
        return;
      }
      const entry = Object.values(locals)[args.variablesReference - 1001];
      respond(request, { variables: entry && typeof entry === "object" ? variablesOf(entry, 2000) : [] });
      return;
    }
    case "source":
      respond(request, { content: "// generated by the adapter\\n" });
      return;
    case "evaluate": {
      const value = Object.prototype.hasOwnProperty.call(locals, args.expression) ? locals[args.expression] : undefined;
      if (value === undefined) {
        respond(request, undefined, false, "name '" + args.expression + "' is not defined in " + launchArgs.program);
        return;
      }
      respond(request, { result: String(value), type: typeof value, variablesReference: 0 });
      return;
    }
    case "continue":
      respond(request, { allThreadsContinued: true });
      event("continued", { threadId: 1, allThreadsContinued: true });
      if (resume) { const go = resume; resume = undefined; go(); }
      return;
    case "next":
    case "stepIn":
    case "stepOut":
      respond(request);
      stepping = true;
      if (resume) { const go = resume; resume = undefined; go(); }
      return;
    case "pause":
      respond(request);
      return;
    case "disconnect":
      respond(request);
      if (program && program.exitCode === null) program.kill("SIGKILL");
      setTimeout(() => process.exit(0), 50);
      return;
    default:
      respond(request, undefined, false, "unsupported");
  }
}

process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    const end = buffered.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const match = /Content-Length: (\\d+)/i.exec(buffered.subarray(0, end).toString("ascii"));
    if (match === null) process.exit(1);
    const length = Number(match[1]);
    if (buffered.length < end + 4 + length) return;
    const body = buffered.subarray(end + 4, end + 4 + length).toString("utf8");
    buffered = buffered.subarray(end + 4 + length);
    const message = JSON.parse(body);
    if (message.type === "request") handle(message);
    else if (message.type === "response") event("output", { category: "console", output: "host answered " + message.command + ": " + String(message.success) + "\\n" });
  }
});
process.stdin.on("end", () => process.exit(0));
`;
}

/**
 * The program the fixture adapter debugs. Line numbers in its checkpoints
 * are the lines a person sets breakpoints on. Its last checkpoint reports,
 * for each attempt to leave its confinement, what happened.
 */
export function fakeDebugProgram(input: {
  readonly outsideMarker: string;
  readonly hostPort: number;
}): string {
  return `"use strict";
const net = require("node:net");
const fs = require("node:fs");
const control = new net.Socket({ fd: 3, readable: true, writable: true });
let waiting;
let buffered = "";
let first = true;
control.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  while (buffered.includes("\\n")) {
    buffered = buffered.slice(buffered.indexOf("\\n") + 1);
    const go = waiting;
    waiting = undefined;
    if (go) go();
  }
});
function at(line, locals) {
  const entry = first;
  first = false;
  return new Promise((resolve) => {
    waiting = resolve;
    control.write(JSON.stringify({ line, locals, first: entry }) + "\\n");
  });
}
function code(error) {
  return "refused " + (error && error.code ? error.code : "error");
}
function write(path) {
  try {
    fs.writeFileSync(path, "escaped\\n");
    return "wrote";
  } catch (error) {
    return code(error);
  }
}
function reach(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve("refused timeout"); }, 3000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
    socket.once("error", (error) => { clearTimeout(timer); resolve(code(error)); });
  });
}
function throughProxy(target) {
  const proxy = new URL(process.env.HTTPS_PROXY || "http://127.0.0.1:9");
  const credentials = Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64");
  return new Promise((resolve) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let answer = "";
    const timer = setTimeout(() => { socket.destroy(); resolve("refused timeout"); }, 5000);
    socket.once("connect", () => socket.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\nProxy-Authorization: Basic " + credentials + "\\r\\n\\r\\n"));
    socket.on("data", (chunk) => { answer += chunk.toString("latin1"); if (answer.includes("\\r\\n\\r\\n")) socket.end(); });
    socket.once("close", () => { clearTimeout(timer); resolve("status " + (answer.split("\\r\\n")[0].split(" ")[1] || "none")); });
    socket.once("error", (error) => { clearTimeout(timer); resolve(code(error)); });
  });
}
async function main() {
  let count = 1;
  await at(40, { count });
  count += 41;
  console.log("counted " + count + " in " + __filename);
  await at(42, { count, secret: "hunter2-session-value", nested: { inner: "deep" } });
  const attempts = {
    writeCheckout: write("written-by-program.txt"),
    writeOutside: write(${JSON.stringify(input.outsideMarker)}),
    reachHost: await reach("127.0.0.1", ${String(input.hostPort)}),
    proxyPublic: await throughProxy("example.com:443"),
  };
  await at(50, { attempts });
  process.exit(0);
}
main();
`;
}
