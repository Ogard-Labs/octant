import { query } from "@anthropic-ai/claude-agent-sdk";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-native-approval-")));
const executable = process.argv[2];
if (!executable) throw new Error("Missing native Claude runtime");
const canary = join(root, "command-ran");
const outside = realpathSync(mkdtempSync(join(tmpdir(), "octant-native-outside-")));
const outsideCanary = join(outside, "command-ran");
const authority = realpathSync(mkdtempSync(join(tmpdir(), "octant-native-authority-")));
const pinNativeLaunch =
  process.platform === "linux"
    ? (await import("../../process/linuxPinnedLaunch.ts")).pinLinuxLaunch
    : undefined;
const boundaryProbe = process.argv[4]?.endsWith("boundary") === true;
const boundaryOptions = process.argv[5] === undefined ? {} : JSON.parse(process.argv[5]);
let calls = 0,
  permissionCalls = 0,
  hookCalls = 0;
const children = [];
const toolResults = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const data = body ? JSON.parse(body) : {};
  if (req.url?.includes("count_tokens")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 20 }));
    return;
  }
  if (!req.url?.includes("/messages")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
    return;
  }
  calls++;
  const answered = (data.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === "tool_result").length;
  if (boundaryProbe)
    toolResults.push(
      ...(data.messages ?? [])
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block) => block.type === "tool_result"),
    );
  const done = answered >= 2;
  const content = done
    ? { type: "text", text: "Done." }
    : {
        type: "tool_use",
        id: "toolu_probe_" + (answered + 1),
        name: "Bash",
        input: {
          command: `printf x >> '${boundaryProbe && answered === 1 ? outsideCanary : canary}'`,
          dangerouslyDisableSandbox: !boundaryProbe,
        },
      };
  const msg = {
    id: "msg_probe_" + calls,
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [content],
    stop_reason: done ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 20 },
  };
  if (!data.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(msg));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: { ...msg, content: [], stop_reason: null },
  });
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: done
      ? { type: "text", text: "" }
      : { type: "tool_use", id: content.id, name: "Bash", input: {} },
  });
  send(
    "content_block_delta",
    done
      ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }
      : {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(content.input) },
        },
  );
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
let session, result;
const timer = setTimeout(() => {
  session?.close();
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
}, 25000);
try {
  const config = join(root, "config");
  mkdirSync(config);
  const unavailable = process.argv[4] === "missing-sandbox";
  const emptyPath = unavailable || process.argv[4] === "no-hook-empty-path";
  const environment = {
    PATH: emptyPath ? root : process.env.PATH,
    SHELL: "/bin/bash",
    HOME: root,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: "offline-protocol-fixture",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
  };
  session = query({
    prompt: "Run the fixture command.",
    options: {
      pathToClaudeCodeExecutable: executable,
      cwd: root,
      model: "claude-sonnet-4-6",
      permissionMode: process.argv[3] ?? "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: ["Bash"],
      settingSources: [],
      sandbox:
        unavailable || process.argv[4] === "native-boundary"
          ? {
              enabled: true,
              failIfUnavailable: true,
              allowUnsandboxedCommands: true,
              autoAllowBashIfSandboxed: false,
              filesystem: {
                denyRead: ["/"],
                allowRead: [root, ...(boundaryOptions.readRoots ?? [])],
                allowWrite: [root],
              },
              network: {
                allowedDomains: ["*"],
                allowAllUnixSockets: false,
                allowUnixSockets: [],
                allowLocalBinding: false,
                allowMachLookup: [],
              },
            }
          : { enabled: false },
      maxTurns: 5,
      env: environment,
      spawnClaudeCodeProcess: (options) => {
        const lifetime = boundaryProbe ? boundaryOptions.lifetimeArguments : undefined;
        const launch =
          lifetime === undefined
            ? { command: options.command, args: options.args }
            : pinNativeLaunch(
                {
                  command: "/usr/bin/bwrap",
                  args: [
                    ...lifetime
                      .slice(0, -1)
                      .map((value) => (value === "__PROJECT_ROOT__" ? root : value)),
                    "--bind",
                    root,
                    root,
                    "--",
                    options.command,
                    ...options.args,
                  ],
                },
                authority,
                undefined,
                true,
              );
        const child = spawn(launch.command, launch.args, {
          cwd: root,
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        return child;
      },
      canUseTool: async () => {
        permissionCalls++;
        if (boundaryProbe) return { behavior: "allow" };
        if (existsSync(canary)) throw new Error("Command ran before its fresh answer");
        return permissionCalls === 1
          ? { behavior: "deny", message: "The person refused this one-command fixture exception." }
          : { behavior: "allow" };
      },
      ...(process.argv[4]?.startsWith("no-hook") || boundaryProbe
        ? {}
        : {
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    async () => {
                      hookCalls++;
                      return {
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse",
                          permissionDecision: "ask",
                        },
                      };
                    },
                  ],
                },
              ],
            },
          }),
    },
  });
  for await (const message of session) {
    if (message.type === "result")
      result = {
        subtype: message.subtype,
        is_error: message.is_error,
        result: message.result,
        errors: message.errors,
      };
  }
  console.log(
    JSON.stringify({
      mode: process.argv[3] ?? "bypassPermissions",
      calls,
      hookCalls,
      permissionCalls,
      commandRan: existsSync(canary),
      commandWrites: existsSync(canary) ? readFileSync(canary, "utf8") : "",
      outsideWrites: existsSync(outsideCanary) ? readFileSync(outsideCanary, "utf8") : "",
      ...(boundaryProbe ? { toolResults } : {}),
      result,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      calls,
      hookCalls,
      permissionCalls,
      commandWrites: existsSync(canary) ? readFileSync(canary, "utf8") : "",
      outsideWrites: existsSync(outsideCanary) ? readFileSync(outsideCanary, "utf8") : "",
      ...(boundaryProbe ? { toolResults } : {}),
      result,
      failure: String(error.message).slice(0, 200),
    }),
  );
} finally {
  clearTimeout(timer);
  session?.close();
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(authority, { recursive: true, force: true });
}
