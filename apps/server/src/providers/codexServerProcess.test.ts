import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { makeCodexProcessLive, SERVER_STRICT_REFUSAL } from "./codexProcess";

const scratches: string[] = [];
afterEach(() => {
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true });
});

/**
 * A stand-in server: `ssh` runs the remote command in `sh` with a `codex` on
 * its PATH that answers `--version` and speaks enough of the app-server
 * protocol to initialize, reporting the folder it was started in.
 */
function standInServer() {
  const scratch = mkdtempSync(join(tmpdir(), "octant-codex-server-"));
  scratches.push(scratch);
  const bin = join(scratch, "bin");
  const folder = join(scratch, "home", "service");
  mkdirSync(bin);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(bin, "codex"),
    `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli 0.170.0'); process.exit(0); }
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'cwd=' + process.cwd() + ' args=' + process.argv.slice(2).join(' ') } }) + '\\n');
  }
});`,
  );
  chmodSync(join(bin, "codex"), 0o700);
  const ssh = join(scratch, "ssh");
  writeFileSync(
    ssh,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const env = { ...process.env, PATH: ${JSON.stringify(bin)} + ':' + process.env.PATH };
const child = spawn('sh', ['-c', process.argv[process.argv.length - 1]], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));`,
  );
  chmodSync(ssh, 0o700);
  const connection = new ServerConnection({
    sshPath: ssh,
    agentSocket: () => undefined,
    controlDirectory: () => scratch,
  });
  return { connection, folder };
}

const server = { alias: "devbox", user: "build" };

function placedThread(folder: string) {
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
    providerInstanceId: "00000000-0000-4000-8000-0000000000ee",
    modelId: "gpt-model",
    executionPolicy: "approval-gated",
  } as unknown as CodeThread;
  return { project, thread };
}

function bind(
  connection: ServerConnection,
  folder: string,
  input: { readonly placesOnServer: boolean; readonly strict: boolean },
) {
  const { project, thread } = placedThread(folder);
  return bindServerCodeTurn(
    {
      store: {
        codeProject: (id) => (id === String(project.id) ? project : undefined),
        addressOf: () => ({ kind: "address", server, folder }),
        serverOf: () => undefined,
      },
      connection,
      composition: { forServerCode: () => undefined },
      record: () => "recorded",
    },
    {
      thread,
      windowId: decodeWindowId("00000000-0000-4000-8000-000000000471"),
      secrets: [],
      ...input,
    },
  );
}

describe.skipIf(process.platform === "win32")("Codex on a server Project's server", () => {
  it("runs Codex's app-server in the Project's folder on the server over the SSH stream", async () => {
    const { connection, folder } = standInServer();
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error(`not placed: ${bound.status}`);

    const started = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const codex = yield* makeCodexProcessLive().start({
            binaryPath: "/nonexistent/codex-on-this-host",
            authority: {
              kind: "thread",
              root: folder,
              mode: "code",
              executionPolicy: "approval-gated",
              strict: false,
            },
            server: bound.placement,
          });
          const agent = yield* Effect.promise(() =>
            codex.rpc.request("initialize", {}, (value) => value as { userAgent: string }),
          );
          return { version: codex.version, agent: agent.userAgent };
        }),
      ),
    );
    expect(started.version).toBe("0.170.0");
    expect(started.agent).toContain(`cwd=${folder}`);
    expect(started.agent).toContain("args=app-server --listen stdio://");
  });

  it("refuses Codex on a server under Strict, before anything runs there", async () => {
    const { connection, folder } = standInServer();
    expect(bind(connection, folder, { placesOnServer: true, strict: true })).toEqual({
      status: "refused",
      message: SERVER_PLACEMENT_STRICT_REFUSAL,
    });
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error("not placed");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeCodexProcessLive().start({
          binaryPath: "/nonexistent/codex",
          authority: {
            kind: "thread",
            root: folder,
            mode: "code",
            executionPolicy: "approval-gated",
          },
          server: bound.placement,
        }),
      ),
    );
    expect(JSON.stringify(exit)).toContain(SERVER_STRICT_REFUSAL);
  });

  it("refuses a runtime that does not report server placement, with a reason", () => {
    const { connection, folder } = standInServer();
    const bound = bind(connection, folder, { placesOnServer: false, strict: false });
    expect(bound.status).toBe("refused");
    if (bound.status === "refused") expect(bound.message).toMatch(/runs on the server itself/);
  });

  it("says Codex is missing on the server rather than running anything here", async () => {
    const { connection, folder } = standInServer();
    rmSync(join(folder, "..", "..", "bin", "codex"));
    const bound = bind(connection, folder, { placesOnServer: true, strict: false });
    if (bound.status !== "placed") throw new Error("not placed");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeCodexProcessLive().start({
          binaryPath: "/nonexistent/codex",
          authority: {
            kind: "thread",
            root: folder,
            mode: "code",
            executionPolicy: "approval-gated",
            strict: false,
          },
          server: bound.placement,
        }),
      ),
    );
    expect(JSON.stringify(exit)).toContain("Codex isn't installed on devbox");
  });
});
