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
 * `threads` request with a frame past the host's cap. `children-event` and
 * `children-start-debugging` announce children of the program, by the
 * `fixtureAttach` event or the standard request, and serve each child's
 * connection on `OCTANT_DEBUG_CHILD_PORT`; the configuration's environment
 * says how many, how far apart, and what each announcement names. The
 * adapter logs what it did with its children to `adapter-log.txt` in the
 * program's folder.
 */

export type FakeDebugAdapterMode =
  | "normal"
  | "reverse-requests"
  | "oversize"
  | "children-event"
  | "children-start-debugging";

export function fakeDebugAdapterScript(mode: FakeDebugAdapterMode = "normal"): string {
  return `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const MODE = ${JSON.stringify(mode)};
let seq = 1;
let parent;

function frame(message) {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), "utf8");
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]);
}
function reader(onMessage, onBroken) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const end = buffered.indexOf("\\r\\n\\r\\n");
      if (end < 0) return;
      const match = /Content-Length: (\\d+)/i.exec(buffered.subarray(0, end).toString("ascii"));
      if (match === null) return onBroken();
      const length = Number(match[1]);
      if (buffered.length < end + 4 + length) return;
      const body = buffered.subarray(end + 4, end + 4 + length).toString("utf8");
      buffered = buffered.subarray(end + 4 + length);
      onMessage(JSON.parse(body));
    }
  };
}
// What the adapter did with its children, in order, for the tests to read.
function log(launchArgs, line) {
  if (launchArgs && launchArgs.cwd) fs.appendFileSync(path.join(launchArgs.cwd, "adapter-log.txt"), line + "\\n");
}

// One DAP connection and the program it debugs: the session's own on stdio,
// or a child's on a connection to the child port.
function connection(write, role, close) {
  const self = { breakpoints: new Map(), launchArgs: {}, program: undefined, control: undefined, resume: undefined, stepping: false, locals: {}, line: 0, childId: undefined };
  const send = (message) => write(frame(message));
  const respond = (request, body, success = true, message) =>
    send({ type: "response", request_seq: request.seq, command: request.command, success, ...(body === undefined ? {} : { body }), ...(message === undefined ? {} : { message }) });
  const event = (name, body) => send({ type: "event", event: name, ...(body === undefined ? {} : { body }) });
  self.event = event;
  self.send = send;

  function startProgram() {
    const args = self.launchArgs;
    self.program = spawn(process.execPath, [args.program, ...(args.args || [])], {
      cwd: args.cwd,
      env: { ...process.env, ...(args.env || {}) },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    self.program.stdout.on("data", (chunk) => event("output", { category: "stdout", output: chunk.toString("utf8") }));
    self.program.stderr.on("data", (chunk) => event("output", { category: "stderr", output: chunk.toString("utf8") }));
    event("output", { category: "telemetry", output: "adapter telemetry" });
    self.control = self.program.stdio[3];
    let pending = "";
    self.control.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      while (pending.includes("\\n")) {
        const at = pending.indexOf("\\n");
        const checkpoint = JSON.parse(pending.slice(0, at));
        pending = pending.slice(at + 1);
        self.line = checkpoint.line;
        self.locals = checkpoint.locals;
        const lines = self.breakpoints.get(args.program) || new Set();
        const stopOnEntry = args.stopOnEntry === true && checkpoint.first === true;
        if (self.stepping || lines.has(self.line) || stopOnEntry) {
          const reason = self.stepping ? "step" : stopOnEntry ? "entry" : "breakpoint";
          self.stepping = false;
          self.resume = () => self.control.write("go\\n");
          event("stopped", { reason, threadId: 1, allThreadsStopped: true, description: "Paused in " + args.program });
        } else {
          self.control.write("go\\n");
        }
      }
    });
    self.program.on("exit", (code) => {
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

  self.handle = (request) => {
    const args = request.arguments || {};
    switch (request.command) {
      case "initialize":
        if (role === "session") self.clientCapabilities = args;
        respond(request, {
          supportsConfigurationDoneRequest: true,
          exceptionBreakpointFilters: [{ filter: "raised", label: "Raised exceptions", default: false }],
        });
        event("initialized");
        return;
      case "launch":
        if (role !== "session") return respond(request, undefined, false, "launch on a child connection");
        self.launchArgs = args;
        // Replaces the relay's socket in the state folder, which the capsule
        // can write, with a link to a socket outside it.
        if (args.env && args.env.FIXTURE_SWAP_RELAY) {
          const relay = path.join(process.env.HOME || "", "child.sock");
          fs.rmSync(relay, { force: true });
          fs.symlinkSync(args.env.FIXTURE_SWAP_RELAY, relay);
          log(args, "relay swapped");
        }
        if (MODE === "reverse-requests") {
          send({ type: "request", command: "runInTerminal", arguments: { kind: "integrated", cwd: "/", args: ["/bin/sh", "-c", "touch /tmp/ran-in-terminal"] } });
          send({ type: "request", command: "startDebugging", arguments: { request: "launch", configuration: { program: "/bin/sh" } } });
        }
        respond(request);
        return;
      case "attach":
        if (role !== "child") return respond(request, undefined, false, "attach on the session's connection");
        self.launchArgs = args;
        self.childId = args.childId;
        log(args, "child " + args.childId + " attached" + (args.connect === undefined ? "" : " with connect"));
        respond(request);
        return;
      case "setBreakpoints": {
        const lines = (args.breakpoints || []).map((breakpoint) => breakpoint.line);
        self.breakpoints.set(args.source.path, new Set(lines));
        respond(request, { breakpoints: lines.map((value) => ({ verified: true, line: value })) });
        return;
      }
      case "setExceptionBreakpoints":
        respond(request, {});
        return;
      case "configurationDone":
        respond(request);
        if (role === "child" && self.launchArgs.env && self.launchArgs.env.FIXTURE_CHILD_EXITS === "1") {
          event("terminated");
          return;
        }
        startProgram();
        if (role === "session") announceChildren(self);
        return;
      case "threads":
        if (MODE === "oversize") {
          write(Buffer.from("Content-Length: " + String(5 * 1024 * 1024) + "\\r\\n\\r\\n"));
          return;
        }
        respond(request, { threads: [{ id: 1, name: "main" }] });
        return;
      case "stackTrace":
        respond(request, {
          stackFrames: [
            { id: 1, name: (role === "child" ? "child " : "main ") + "(" + self.launchArgs.program + ")", source: { path: self.launchArgs.program }, line: self.line, column: 1 },
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
          respond(request, { variables: variablesOf(self.locals, 1000) });
          return;
        }
        const entry = Object.values(self.locals)[args.variablesReference - 1001];
        respond(request, { variables: entry && typeof entry === "object" ? variablesOf(entry, 2000) : [] });
        return;
      }
      case "source":
        respond(request, { content: "// generated by the adapter\\n" });
        return;
      case "evaluate": {
        const value = Object.prototype.hasOwnProperty.call(self.locals, args.expression) ? self.locals[args.expression] : undefined;
        if (value === undefined) {
          respond(request, undefined, false, "name '" + args.expression + "' is not defined in " + self.launchArgs.program);
          return;
        }
        respond(request, { result: String(value), type: typeof value, variablesReference: 0 });
        return;
      }
      case "continue":
        respond(request, { allThreadsContinued: true });
        event("continued", { threadId: 1, allThreadsContinued: true });
        if (self.resume) { const go = self.resume; self.resume = undefined; go(); }
        return;
      case "next":
      case "stepIn":
      case "stepOut":
        respond(request);
        self.stepping = true;
        if (self.resume) { const go = self.resume; self.resume = undefined; go(); }
        return;
      case "pause":
        respond(request);
        return;
      case "disconnect":
        if (role === "session") {
          const env = self.launchArgs.env || {};
          if (env.FIXTURE_ANNOUNCE_ON_DISCONNECT === "1") announce(self, 99);
          log(self.launchArgs, "session disconnected");
        } else {
          log(self.launchArgs, "child " + self.childId + " disconnected");
        }
        respond(request);
        if (self.program && self.program.exitCode === null) self.program.kill("SIGKILL");
        setTimeout(close, 50);
        return;
      default:
        respond(request, undefined, false, "unsupported");
    }
  };
  return self;
}

// Children: each is announced on the session's connection, then attached on
// a connection of its own to the child port. Announcements and what they
// name come from the configuration's environment, so one fixture serves
// every case.
const childClosed = new Map();
function announce(session, childId) {
  const env = session.launchArgs.env || {};
  const configuration = {
    request: "attach",
    name: "Child process " + childId,
    childId,
    program: session.launchArgs.program,
    args: [...(session.launchArgs.args || []), "--child"],
    cwd: session.launchArgs.cwd,
    env,
    connect: {
      host: env.FIXTURE_ANNOUNCE_HOST || "127.0.0.1",
      port: Number(env.FIXTURE_ANNOUNCE_PORT || process.env.OCTANT_DEBUG_CHILD_PORT || 0),
    },
  };
  log(session.launchArgs, "child " + childId + " announced");
  if (MODE === "children-start-debugging") {
    session.send({ type: "request", command: "startDebugging", arguments: { request: "attach", configuration } });
  } else {
    session.event("fixtureAttach", configuration);
  }
}
async function announceChildren(session) {
  if (MODE !== "children-event" && MODE !== "children-start-debugging") return;
  const env = session.launchArgs.env || {};
  const count = Number(env.FIXTURE_CHILDREN || 1);
  const gap = Number(env.FIXTURE_CHILD_GAP_MS || 0);
  for (let childId = 1; childId <= count; childId += 1) {
    let closed;
    childClosed.set(childId, new Promise((resolve) => { closed = resolve; }));
    childClosed.set("resolve-" + childId, closed);
    announce(session, childId);
    if (gap > 0) await Promise.race([childClosed.get(childId), new Promise((resolve) => setTimeout(resolve, gap))]);
  }
}

if (process.env.OCTANT_DEBUG_CHILD_PORT) {
  const server = net.createServer((socket) => {
    const child = connection((bytes) => socket.write(bytes), "child", () => socket.end());
    socket.on("data", reader((message) => { if (message.type === "request") child.handle(message); }, () => socket.destroy()));
    socket.on("close", () => {
      if (child.program && child.program.exitCode === null) child.program.kill("SIGKILL");
      const resolve = childClosed.get("resolve-" + child.childId);
      if (resolve) resolve();
    });
    socket.on("error", () => undefined);
  });
  server.listen(Number(process.env.OCTANT_DEBUG_CHILD_PORT), "127.0.0.1");
}

parent = connection((bytes) => process.stdout.write(bytes), "session", () => process.exit(0));
process.stdin.on("data", reader((message) => {
  if (message.type === "request") parent.handle(message);
  else if (message.type === "response") parent.event("output", { category: "console", output: "host answered " + message.command + ": " + String(message.success) + "\\n" });
}, () => process.exit(1)));
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
