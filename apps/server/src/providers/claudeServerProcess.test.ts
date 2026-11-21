import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWindowId, type CodeThread } from "@octant/contracts";
import type { ServerProject } from "@octant/contracts/server-projects";
import { ServerConnection } from "../serverProjects/serverConnection";
import {
  bindServerCodeTurn,
  SERVER_PLACEMENT_STRICT_REFUSAL,
  serverCodeCheckout,
} from "../serverProjects/serverProjectThreads";
import { makeClaudeProcessLive } from "./claudeProcess";
import {
  CLAUDE_SERVER_PROGRAM,
  CLAUDE_SERVER_STRICT_REFUSAL,
  claudeSessionOnServer,
  readClaudeInstructionsOnServer,
} from "./claudeServerProcess";

const scratches: string[] = [];
afterEach(() => {
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true });
});

/**
 * A stand-in server: `ssh` runs the remote command in `sh` with the login's
 * own environment (its own `HOME`, nothing of the caller's) and a `claude` on
 * its PATH. That `claude` answers `--version` and, on the SDK's stream-json
 * protocol, answers the SDK's `initialize` request with the folder it was
 * started in, its arguments, and what its environment held. Any launch other
 * than `--version` leaves a mark, so a test can tell nothing ran.
 */
function standInServer() {
  const scratch = mkdtempSync(join(tmpdir(), "octant-claude-server-"));
  scratches.push(scratch);
  const bin = join(scratch, "bin");
  const home = join(scratch, "home", "build");
  const folder = join(home, "service");
  const launched = join(scratch, "launched");
  mkdirSync(bin);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('2.1.300 (Claude Code)'); process.exit(0); }
require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'launched');
const report = 'cwd=' + process.cwd() + ' args=' + process.argv.slice(2).join(' ') +
  ' key=' + (process.env.ANTHROPIC_API_KEY ?? 'none') + ' home=' + process.env.HOME +
  ' state=' + (process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS ?? 'none') +
  ' entry=' + (process.env.CLAUDE_CODE_ENTRYPOINT ?? 'none');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id,
      response: { commands: [], models: [], account: {}, report },
    } }) + '\\n');
  }
});`,
  );
  chmodSync(join(bin, "claude"), 0o700);
  // The login's PATH holds the stand-in and Node alone, so a `claude` this
  // host has installed is never the one that answers.
  const nodeBin = join(scratch, "node-bin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  const serverPath = [bin, nodeBin, "/usr/bin", "/bin"].join(":");
  const ssh = join(scratch, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const env = { PATH: ${JSON.stringify(serverPath)}, HOME: ${JSON.stringify(home)} };
const child = spawn('sh', ['-c', process.argv[process.argv.length - 1]], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));`,
  );
  chmodSync(ssh, 0o700);
  const connection = new ServerConnection({
    sshPath: ssh,
    agentSocket: () => undefined,
    controlDirectory: () => scratch,
  });
  return { connection, folder, home, bin, launched };
}

function bind(
  connection: ServerConnection,
  folder: string,
  input: { readonly placesOnServer: boolean; readonly strict: boolean },
) {
  const project = {
    id: "11111111-1111-4111-8111-111111111111" as ServerProject["id"],
    name: "Service",
    serverId: "5e7e0000-0000-4000-8000-000000000001" as ServerProject["serverId"],
    folder,
    boundAt: "2026-11-01T12:00:00.000Z" as ServerProject["boundAt"],
  };
  const derived = serverCodeCheckout(project);
  const thread = {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: project.id,
    bindingRevisionId: derived.bindingRevisionId,
    repositoryId: derived.checkout.repositoryId,
    checkoutId: derived.checkout.id,
    providerInstanceId: "00000000-0000-4000-8000-0000000000ef",
    modelId: "claude-sonnet",
    executionPolicy: "approval-gated",
  } as unknown as CodeThread;
  return bindServerCodeTurn(
    {
      store: {
        codeProject: (id) => (id === String(project.id) ? project : undefined),
        addressOf: () => ({ kind: "address", server: { alias: "devbox", user: "build" }, folder }),
        serverOf: () => undefined,
      },
      connection,
      composition: { forServerCode: () => undefined },
      record: () => "recorded",
    },
    {
      thread,
      windowId: decodeWindowId("00000000-0000-4000-8000-000000000472"),
      secrets: [],
      ...input,
    },
  );
}

/** A prompt stream that sends nothing until it is ended, as a session waiting for its first turn. */
function waitingPrompt() {
  let end: () => void = () => undefined;
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          end = () => resolve({ done: true, value: undefined });
        }),
    }),
  };
  return { prompt, end: () => end() };
}

describe.skipIf(process.platform === "win32")("Claude Code on a server Project's server", () => {
  // The real Agent SDK drives the launch here, through the real process port
  // and SSH stream, against a stand-in `claude` that speaks only the SDK's
  // `initialize` exchange. Octant's driver adds a model catalog and a turn on
  // top, which a stand-in cannot answer honestly; the driver's placed path is
  // covered against its ports in `claudeDriver.test.ts`.
  it("runs Claude Code on a server Project's server over the SSH stream, in the Project's folder", async () => {
    const { connection, folder, home } = standInServer();
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error(`not placed: ${bound.status}`);
    const port = makeClaudeProcessLive();

    const version = await Effect.runPromise(
      port.probeVersion("/nonexistent/claude-on-this-host", bound.placement),
    );
    expect(version).toBe("2.1.300");

    const { prompt, end } = waitingPrompt();
    const session = query({
      prompt,
      options: {
        cwd: folder,
        pathToClaudeCodeExecutable: CLAUDE_SERVER_PROGRAM,
        // What a local launch's environment could hold: none of it may reach the server.
        env: {
          ANTHROPIC_API_KEY: "host-secret-sentinel",
          HOME: "/Users/host-person",
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        },
        spawnClaudeCodeProcess: port.spawn({
          projectRoot: folder,
          executionPolicy: "approval-gated",
          strict: false,
          server: bound.placement,
        }),
      },
    });
    try {
      const report = JSON.stringify(await session.initializationResult());
      expect(report).toContain(`cwd=${folder}`);
      expect(report).toContain("--input-format stream-json");
      expect(report).toContain("key=none");
      expect(report).toContain(`home=${home}`);
      expect(report).toContain("state=1");
      expect(report).toContain("entry=sdk-ts");
      expect(report).not.toContain("host-secret-sentinel");
    } finally {
      end();
      session.close();
    }
  });

  it("refuses Claude Code on a server under Strict", () => {
    const { connection, folder, launched } = standInServer();
    expect(bind(connection, folder, { placesOnServer: true, strict: true })).toEqual({
      status: "refused",
      message: SERVER_PLACEMENT_STRICT_REFUSAL,
    });
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error("not placed");
    // The process port refuses too, for any caller that reaches it under Strict.
    const spawn = makeClaudeProcessLive().spawn({
      projectRoot: folder,
      executionPolicy: "approval-gated",
      server: bound.placement,
    });
    expect(() =>
      spawn({
        command: CLAUDE_SERVER_PROGRAM,
        args: ["--output-format", "stream-json"],
        cwd: folder,
        env: {},
        signal: new AbortController().signal,
      }),
    ).toThrow(CLAUDE_SERVER_STRICT_REFUSAL);
    expect(existsSync(launched)).toBe(false);
  });

  it("reads the server's instruction files as text when their setting source is off, never through a link", async () => {
    const { connection, folder, home } = standInServer();
    mkdirSync(join(folder, ".claude", "rules"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(folder, "CLAUDE.md"), "Run the unit tests first.\n");
    writeFileSync(join(folder, ".claude", "rules", "style.md"), "Two-space indents.\n");
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "Answer briefly.\n");
    writeFileSync(join(home, "secret.txt"), "not an instruction\n");
    symlinkSync(join(home, "secret.txt"), join(folder, "CLAUDE.local.md"));
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error("not placed");

    const both = await readClaudeInstructionsOnServer(bound.placement, {
      project: true,
      account: true,
    });
    expect(both).toContain("Run the unit tests first.");
    expect(both).toContain("Two-space indents.");
    expect(both).toContain("Answer briefly.");
    expect(both).not.toContain("not an instruction");
    const projectOnly = await readClaudeInstructionsOnServer(bound.placement, {
      project: true,
      account: false,
    });
    expect(projectOnly).not.toContain("Answer briefly.");
    expect(
      await readClaudeInstructionsOnServer(bound.placement, { project: false, account: false }),
    ).toBeUndefined();
  });

  it("reports a Project folder it cannot open as unreachable, not as a lost session", async () => {
    const { connection, folder } = standInServer();
    const bound = bind(connection, join(folder, "gone"), { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error("not placed");
    expect(
      await claudeSessionOnServer(bound.placement, "33333333-3333-4333-8333-333333333333"),
    ).toMatchObject({ status: "unreachable" });
  });

  it("says Claude Code is missing on the server rather than running anything here", async () => {
    const { connection, folder, bin, launched } = standInServer();
    rmSync(join(bin, "claude"));
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error("not placed");
    const exit = await Effect.runPromiseExit(
      makeClaudeProcessLive().probeVersion("/nonexistent/claude", bound.placement),
    );
    expect(JSON.stringify(exit)).toContain(
      "Claude Code isn't installed on devbox, or isn't on the PATH an SSH login gets there.",
    );
    expect(existsSync(launched)).toBe(false);
  });
});
