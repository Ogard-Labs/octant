import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageServerProcessPort } from "../code/languageServerProcess";
import { TerminalProcessPort } from "../code/terminalProcessPort";
import { makeProcessConfinementLive } from "./seatbeltProfile";

// A child that forks, starts a session of its own in the fork, and lets the
// parent exit, so the fork is an orphan outside the launch's process group.
// It records its pid and then writes a heartbeat into the folder it runs in.
const ESCAPE_COMMAND = `/usr/bin/perl -e 'use POSIX; if (!fork) { POSIX::setsid(); exec "/bin/sh", "./beat.sh" }'`;
const HEARTBEAT_SCRIPT = `#!/bin/sh
echo $$ > pid
i=0
while :; do i=$((i+1)); echo $i > beat; sleep 0.2; done
`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    endLeftoverHeartbeat(join(root, "checkout"));
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): { readonly root: string; readonly checkout: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-session-escape-")));
  chmodSync(root, 0o700);
  roots.push(root);
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "beat.sh"), HEARTBEAT_SCRIPT, { mode: 0o755 });
  return { root, checkout };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readBeat(checkout: string): string | undefined {
  try {
    return readFileSync(join(checkout, "beat"), "utf8").trim();
  } catch {
    return undefined;
  }
}

async function waitForHeartbeat(checkout: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (readBeat(checkout) === undefined) {
    if (Date.now() > deadline) throw new Error("The escaping child never started.");
    await delay(50);
  }
}

/** True when the heartbeat still advances a second after the stop settled. */
async function heartbeatContinues(checkout: string): Promise<boolean> {
  await delay(600);
  const before = readBeat(checkout);
  await delay(1_000);
  return readBeat(checkout) !== before;
}

/**
 * Ends a child a failing run left behind. Only the pid it recorded, and only
 * while that pid still runs this test's heartbeat from its own folder.
 */
function endLeftoverHeartbeat(checkout: string): void {
  let pid: number;
  try {
    pid = Number(readFileSync(join(checkout, "pid"), "utf8").trim());
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid < 2) return;
  let cwd = "";
  try {
    cwd = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    return;
  }
  if (!cwd.split("\n").includes(`n${checkout}`)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function launchToolingServer(root: string, checkout: string, receiptDirectory: string) {
  const install = join(root, "install");
  const cacheRoot = join(root, "cache");
  const cacheDirectory = join(cacheRoot, "server");
  mkdirSync(install);
  const executable = join(install, "server.sh");
  writeFileSync(executable, `#!/bin/sh\n${ESCAPE_COMMAND}\nexec /bin/sleep 600\n`, {
    mode: 0o755,
  });
  const port = new LanguageServerProcessPort({
    confinement: makeProcessConfinementLive(),
    receiptDirectory,
    egress: {
      start: async () => ({
        status: "listening" as const,
        endpoint: { kind: "loopback" as const, port: 9 },
        token: "session-escape",
        close: async () => undefined,
      }),
    },
  });
  const outcome = await port.launch({
    ownerId: "session-escape",
    launchClass: "repo-tooling",
    egress: { projectId: "project", threadId: "thread", checkoutTainted: () => false },
    executable,
    args: [],
    installRoot: install,
    checkoutRoot: checkout,
    cacheDirectory,
    cacheRoot,
  });
  if (outcome.status !== "launched") throw new Error(`Server did not launch: ${outcome.status}`);
  return outcome.process;
}

describe.runIf(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))(
  "a confined child that starts its own session on macOS",
  () => {
    it("ends with the repository-tooling server that started it", async () => {
      const { root, checkout } = makeRoot();
      const server = await launchToolingServer(root, checkout, join(root, "receipts"));
      await waitForHeartbeat(checkout);
      await server.kill();
      expect(await heartbeatContinues(checkout)).toBe(false);
    });

    it("ends when a restarted host reaps the server a previous run left behind", async () => {
      const { root, checkout } = makeRoot();
      const receiptDirectory = join(root, "receipts");
      await launchToolingServer(root, checkout, receiptDirectory);
      await waitForHeartbeat(checkout);
      await new LanguageServerProcessPort({
        confinement: makeProcessConfinementLive(),
        receiptDirectory,
      }).reconcile();
      expect(await heartbeatContinues(checkout)).toBe(false);
    });

    it("ends when the terminal that ran it closes", async () => {
      const { root, checkout } = makeRoot();
      const temporaryDirectory = join(root, "tmp");
      mkdirSync(temporaryDirectory);
      const handle = new TerminalProcessPort({
        confinement: makeProcessConfinementLive(),
        temporaryDirectory,
        shellStateDirectory: join(root, "shell"),
        receiptDirectory: join(root, "receipts"),
        networkEgress: "none",
        platform: "darwin",
      }).start({
        shell: "/bin/zsh",
        cwd: checkout,
        stateScope: "session-escape",
        environment: { HOME: temporaryDirectory, PATH: "/usr/bin:/bin", TERM: "dumb" },
        columns: 80,
        rows: 24,
      });
      await handle.receiptReady;
      handle.write(`${ESCAPE_COMMAND}\r`);
      await waitForHeartbeat(checkout);
      await handle.close();
      expect(await heartbeatContinues(checkout)).toBe(false);
    });
  },
);
