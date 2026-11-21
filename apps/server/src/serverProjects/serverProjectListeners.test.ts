import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConnection } from "./serverConnection";
import { listServerProjectListeners, parseServerListeners } from "./serverProjectListeners";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A process listening on a free port, working in `cwd`, and the port it got. */
async function listenIn(cwd: string): Promise<number> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "-e",
      "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))",
    ],
    { cwd, stdio: ["ignore", "pipe", "ignore"] },
  );
  cleanups.push(() => child.kill("SIGKILL"));
  return await new Promise<number>((resolve) =>
    child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString("utf8").trim()))),
  );
}

describe("the TCP ports a server Project serves", () => {
  it("keeps one entry per valid port and the process's short name alone", () => {
    expect(
      parseServerListeners("5173\tnode\n5173\tnode\n99999\tbad\nx\ty\n3000\tpython3\n"),
    ).toEqual([
      { port: 3000, processName: "python3" },
      { port: 5173, processName: "node" },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "lists only the login's listeners working inside the Project folder",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "octant-listeners-"));
      cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
      const project = join(scratch, "project");
      const elsewhere = join(scratch, "elsewhere");
      mkdirSync(project);
      mkdirSync(elsewhere);
      const executable = join(scratch, "ssh");
      // The last argument is the remote command, which a server's login shell runs.
      writeFileSync(
        executable,
        `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn('sh', ['-c', process.argv[process.argv.length - 1]], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));`,
      );
      chmodSync(executable, 0o700);
      const inside = await listenIn(project);
      const outside = await listenIn(elsewhere);

      const read = await listServerProjectListeners({
        connection: new ServerConnection({
          sshPath: executable,
          agentSocket: () => undefined,
          controlDirectory: () => scratch,
        }),
        server: { alias: "fixture", user: "fixture" },
        folder: `${project}/`,
      });

      if (read.status !== "listed") throw new Error(read.message);
      const ports = read.listeners.map((listener) => listener.port);
      expect(ports).toContain(inside);
      expect(ports).not.toContain(outside);
    },
  );
});
