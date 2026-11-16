import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBubblewrapLaunch, DEFAULT_BWRAP_PATH } from "./linuxConfinement";
import { writeLinuxPlanShellPrefix } from "./linuxPlanShellCapsule";
import { ProcessConfinementError } from "./seatbeltProfile";

const SETPRIV_PATH = "/usr/bin/setpriv";
const ORDINARY_UID = 65_534;
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/**
 * The capsule needs a user namespace inside another, which a root host cannot
 * map; such a host runs the check as an ordinary user, as Octant itself runs.
 */
function asOrdinaryUser(): boolean {
  return process.getuid?.() !== 0 || existsSync(SETPRIV_PATH);
}

function runAsHostUser(command: string, args: ReadonlyArray<string>) {
  if (process.getuid?.() !== 0) return spawnSync(command, [...args], { encoding: "utf8" });
  return spawnSync(
    SETPRIV_PATH,
    [
      `--reuid=${String(ORDINARY_UID)}`,
      `--regid=${String(ORDINARY_UID)}`,
      "--clear-groups",
      "--",
      command,
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "sk-test-not-a-real-key" } },
  );
}

/**
 * A root host builds the outer capsule's empty deny covers as root, private to
 * root, and an ordinary user's Bubblewrap cannot bind them. They are empty
 * files and folders, so opening them to that user hides nothing more.
 */
function openDenyCoversToHostUser(args: ReadonlyArray<string>): void {
  if (process.getuid?.() !== 0) return;
  for (const [index, arg] of args.entries()) {
    const source = args[index + 1];
    if (arg !== "--ro-bind" || source === undefined) continue;
    if (!source.startsWith(join(tmpdir(), "octant-deny-"))) continue;
    chmodSync(dirname(source), 0o755);
    chmodSync(source, statSync(source).isDirectory() ? 0o755 : 0o644);
  }
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-plan-shell-")));
  directories.push(root);
  chmodSync(root, 0o755);
  const project = join(root, "project");
  const account = join(root, "account");
  const temporaryDirectory = join(root, "tmp");
  const shellFolder = join(root, "shell");
  for (const folder of [project, account, temporaryDirectory, shellFolder]) {
    mkdirSync(folder, { mode: 0o755 });
  }
  writeFileSync(join(project, "notes.txt"), "needle line\n", { mode: 0o644 });
  writeFileSync(join(account, ".credentials.json"), '{"token":"secret"}\n', { mode: 0o644 });
  if (process.getuid?.() === 0) chownSync(temporaryDirectory, ORDINARY_UID, ORDINARY_UID);
  return { root, project, account, temporaryDirectory, shellFolder };
}

async function listener(): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No listener port.");
  return address.port;
}

describe("Linux Plan shell capsule", () => {
  it("refuses to keep its program in the folder commands may write", () => {
    const { temporaryDirectory, project } = fixture();
    expect(() =>
      writeLinuxPlanShellPrefix(join(temporaryDirectory, "inner"), {
        bwrapPath: DEFAULT_BWRAP_PATH,
        shell: "/bin/bash",
        readRoots: [project],
        temporaryDirectory,
      }),
    ).toThrow(ProcessConfinementError);
  });

  it.runIf(process.platform === "linux" && existsSync(DEFAULT_BWRAP_PATH) && asOrdinaryUser())(
    "runs a Plan command that reads the Project but cannot write outside temp, read the sign-in, see the API key or reach the network",
    async () => {
      const { project, account, temporaryDirectory, shellFolder } = fixture();
      const port = await listener();
      const prefix = writeLinuxPlanShellPrefix(shellFolder, {
        bwrapPath: DEFAULT_BWRAP_PATH,
        shell: "/bin/bash",
        readRoots: [project],
        temporaryDirectory,
      });
      // Owner-only, as the host user owns it; a root host runs the check as
      // another user.
      if (process.getuid?.() === 0) chmodSync(prefix, 0o555);
      const credentials = join(account, ".credentials.json");
      const command = [
        `echo "read=$(cat ${project}/notes.txt)"`,
        `if { echo changed > ${project}/notes.txt; } 2>/dev/null; then echo project-write=allowed; else echo project-write=refused; fi`,
        `echo scratch > "$TMPDIR/scratch.txt" && echo "temp-write=$(cat "$TMPDIR/scratch.txt")"`,
        `if cat ${credentials} >/dev/null 2>&1; then echo sign-in=readable; else echo sign-in=hidden; fi`,
        'echo "api-key=${ANTHROPIC_API_KEY:-unset}"',
        `if (exec 3<>/dev/tcp/127.0.0.1/${String(port)}) 2>/dev/null; then echo network=reached; else echo network=blocked; fi`,
      ].join("\n");
      // The runtime's own capsule, as a Plan launch that runs commands builds
      // it: the network open, the account folder readable, processes admitted.
      const outer = buildBubblewrapLaunch({
        executable: "/bin/bash",
        args: [
          "-c",
          // The runtime itself reaches the listener and reads its sign-in;
          // the command it starts through the prefix does neither.
          `(exec 3<>/dev/tcp/127.0.0.1/${String(port)}) 2>/dev/null && echo runtime-network=reached
cat ${credentials} >/dev/null && echo runtime-sign-in=readable
cd ${project} && "$0" "$1"`,
          prefix,
          command,
        ],
        boundRoot: project,
        temporaryDirectory,
        readRoots: [account, shellFolder],
        privateHomeAllowPaths: [account, shellFolder],
        writeBoundRoot: false,
        allowProcessExec: true,
        allowProcessFork: true,
        startsNestedCapsules: true,
        networkEgress: "allow",
      });
      openDenyCoversToHostUser(outer.args);
      const result = runAsHostUser(outer.command, outer.args);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toEqual([
        "runtime-network=reached",
        "runtime-sign-in=readable",
        "read=needle line",
        "project-write=refused",
        "temp-write=scratch",
        "sign-in=hidden",
        "api-key=unset",
        "network=blocked",
      ]);
      expect(readFileSync(join(project, "notes.txt"), "utf8")).toBe("needle line\n");
    },
  );

  it.runIf(process.platform === "linux" && existsSync(DEFAULT_BWRAP_PATH))(
    "fails a command closed when the nested capsule cannot be built, running nothing outside it",
    () => {
      const { project, temporaryDirectory, shellFolder } = fixture();
      const marker = join(temporaryDirectory, "ran");
      const prefix = writeLinuxPlanShellPrefix(shellFolder, {
        // A Bubblewrap that is not there stands in for one that cannot nest.
        bwrapPath: join(shellFolder, "missing-bwrap"),
        shell: "/bin/bash",
        readRoots: [project],
        temporaryDirectory,
      });
      const result = spawnSync(prefix, [`touch ${marker}`], { cwd: project, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    },
  );
});
