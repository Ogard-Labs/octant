import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConnection } from "./serverConnection";
import { listServerProjectListeners, parseServerListeners } from "./serverProjectListeners";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A process listening on a free port of `host`, working in `cwd`, and the port it got. */
async function listenIn(cwd: string, host = "127.0.0.1"): Promise<number> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "-e",
      `const s=require('net').createServer().listen(0,${JSON.stringify(host)},()=>console.log(s.address().port))`,
    ],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  });
  return await new Promise<number>((resolve) =>
    child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString("utf8").trim()))),
  );
}

/** A stand-in `ssh` that runs the remote command with `sh`, and its scratch folder. */
function fixtureServer(environment = ""): {
  readonly scratch: string;
  readonly connection: ServerConnection;
} {
  const scratch = mkdtempSync(join(tmpdir(), "octant-listeners-"));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  const executable = join(scratch, "ssh");
  // The last argument is the remote command, which a server's login shell runs.
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn('/bin/sh', ['-c', process.argv[process.argv.length - 1]], { stdio: 'inherit', env: { ...process.env, ${environment} } });
child.on('exit', (code) => process.exit(code ?? 1));`,
  );
  chmodSync(executable, 0o700);
  return {
    scratch,
    connection: new ServerConnection({
      sshPath: executable,
      agentSocket: () => undefined,
      controlDirectory: () => scratch,
    }),
  };
}

describe("the TCP ports a server Project serves", () => {
  it("keeps one entry per valid port and the process's short name alone", () => {
    expect(
      parseServerListeners(
        "5173\tnode\t127.0.0.1\n5173\tnode\t[::1]\n99999\tbad\t*\nx\ty\n3000\tpython3\t*\n",
      ),
    ).toEqual([
      { port: 3000, processName: "python3", loopbackReachable: true },
      { port: 5173, processName: "node", loopbackReachable: true },
    ]);
  });

  it("offers a preview only for sockets the forward to 127.0.0.1 reaches", () => {
    expect(
      parseServerListeners(
        [
          "3000\tnode\t127.0.0.1",
          "3001\tnode\t0.0.0.0",
          "3002\tnode\t*",
          "3003\tnode\t[::]",
          "4000\tnode\t[::1]",
          "4001\tnode\t192.168.1.20",
          "4002\tnode\t[fe80::1%eth0]",
          "3004\tnode\t[::ffff:127.0.0.1]",
          "4003\tnode\t[::ffff:192.168.1.20]",
        ].join("\n"),
      ).map((listener) => [listener.port, listener.loopbackReachable]),
    ).toEqual([
      [3000, true],
      [3001, true],
      [3002, true],
      [3003, true],
      [3004, true],
      [4000, false],
      [4001, false],
      [4002, false],
      [4003, false],
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "says the server cannot be read when it has neither lsof nor ss",
    async () => {
      // Every program the login's PATH offers except the two listing tools.
      const bin = mkdtempSync(join(tmpdir(), "octant-no-tools-"));
      cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
      for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (directory === "" || !existsSync(directory)) continue;
        for (const name of readdirSync(directory)) {
          if (name === "lsof" || name === "ss" || existsSync(join(bin, name))) continue;
          symlinkSync(join(directory, name), join(bin, name));
        }
      }
      const { connection } = fixtureServer(`PATH: ${JSON.stringify(bin)}`);

      const read = await listServerProjectListeners({
        connection,
        server: { alias: "fixture", user: "fixture" },
        folder: "/srv/site",
      });

      expect(read).toEqual({
        status: "unavailable",
        message: "The server has neither lsof nor ss, so Octant can't see what it serves.",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "lists only the login's listeners working inside the Project folder",
    async () => {
      const { scratch, connection } = fixtureServer();
      const project = join(scratch, "project");
      const elsewhere = join(scratch, "elsewhere");
      mkdirSync(project);
      mkdirSync(elsewhere);
      const inside = await listenIn(project);
      const outside = await listenIn(elsewhere);

      const read = await listServerProjectListeners({
        connection,
        server: { alias: "fixture", user: "fixture" },
        folder: `${project}/`,
      });

      if (read.status !== "listed") throw new Error(read.message);
      expect(read.listeners.find((listener) => listener.port === inside)).toMatchObject({
        loopbackReachable: true,
      });
      expect(read.listeners.map((listener) => listener.port)).not.toContain(outside);
    },
  );
});
