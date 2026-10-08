import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { createNativeHarnessShell } from "./nativeHarnessShell";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// These run the real `sandbox-exec`: the shell entry point only matters if a
// command actually starts under the profile a harness turn gets.
describe.skipIf(process.platform !== "darwin")("native harness shell under Seatbelt", () => {
  it("runs a command in the checkout without the server's ambient secrets", async () => {
    vi.stubEnv("OCTANT_AMBIENT_SECRET", "must-not-leak");
    const { shell, checkout } = harnessShell("allow");

    const run = await shell.run({
      command: 'printf "%s|%s|%s" "$(pwd)" "${OCTANT_AMBIENT_SECRET:-absent}" "$NO_COLOR"',
      cwd: checkout,
      timeoutMs: 10_000,
    });

    expect(run).toMatchObject({ status: "ran", exitCode: 0 });
    expect(run.output).toBe(`${checkout}|absent|1`);
  });

  it("reaches a loopback listener only from the networked shell", async () => {
    const listener = await loopbackListener();
    // nc rather than curl: a confined curl stops reading its TLS configuration
    // before it opens a socket, which would make the offline half pass for
    // the wrong reason.
    const command = `printf 'GET / HTTP/1.0\\r\\n\\r\\n' | /usr/bin/nc -w 5 127.0.0.1 ${listener.port}`;

    const offline = harnessShell("none");
    const refused = await offline.shell.run({
      command,
      cwd: offline.checkout,
      timeoutMs: 10_000,
    });
    expect(refused.status).toBe("ran");
    expect(refused.status === "ran" ? refused.exitCode : undefined).not.toBe(0);
    expect(listener.connections()).toBe(0);

    const networked = harnessShell("allow");
    const reached = await networked.shell.run({
      command,
      cwd: networked.checkout,
      timeoutMs: 10_000,
    });
    expect(reached).toMatchObject({ status: "ran", exitCode: 0 });
    expect(reached.output).toContain("reached");
    expect(listener.connections()).toBe(1);
  });

  it("ends the command's whole process tree when it times out", async () => {
    const { shell, checkout } = harnessShell("allow");

    const run = await shell.run({
      command: "/bin/sleep 60 &\necho $!\nwait",
      cwd: checkout,
      timeoutMs: 1_000,
    });

    expect(run.status).toBe("timed-out");
    await expectGone(Number(run.output.trim()));
  });

  it("ends the command's whole process tree when the turn is cancelled", async () => {
    const { shell, checkout } = harnessShell("none");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_000);

    const run = await shell.run({
      command: "/bin/sleep 60 &\necho $!\nwait",
      cwd: checkout,
      timeoutMs: 30_000,
      signal: controller.signal,
    });

    expect(run.status).toBe("cancelled");
    await expectGone(Number(run.output.trim()));
  });
});

function harnessShell(networkEgress: "allow" | "none") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-harness-shell-")));
  directories.push(root);
  const checkout = join(root, "checkout");
  const work = join(root, "work");
  mkdirSync(checkout);
  mkdirSync(work, { mode: 0o700 });
  const process = new RepositoryTestProcessPort({
    receiptDirectory: join(root, "receipts"),
    temporaryDirectory: work,
    networkEgress,
    harnessShellScripts: true,
  });
  return { shell: createNativeHarnessShell({ process, scriptDirectory: work }), checkout };
}

async function loopbackListener() {
  let connections = 0;
  const server = createServer((_request, response) => response.end("reached"));
  server.on("connection", () => {
    connections += 1;
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
}

async function expectGone(pid: number): Promise<void> {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} outlived its command.`);
}
