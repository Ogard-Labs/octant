// Runs the Windows confinement launcher for real on a hosted Windows runner:
// the server's own port prepares each launch, and the native launcher applies
// it. It proves the AppContainer, ACL and job mechanism on that runner only (an
// administrator account); it runs no provider and lifts no Windows refusal.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPrepareInput,
} from "../apps/server/src/process/seatbeltProfile";

if (process.platform !== "win32")
  throw new Error("Confinement acceptance requires native Windows.");
const launcherPath = resolve(process.argv[2] ?? "");
if (!launcherPath.endsWith("octant-windows-confine.exe"))
  throw new Error("Supply the owned native launcher build.");

const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const cmd = join(system32, "cmd.exe");
const curl = join(system32, "curl.exe");
// The long-name form: a runner's temp folder can arrive as an 8.3 short name.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "octant-confine-")));
const home = realpathSync.native(homedir());
const granted = join(root, "granted");
const readOnly = join(root, "read-only");
const outside = join(root, "outside");
const temporary = join(root, "tmp");
for (const folder of [granted, join(granted, "profile"), readOnly, outside, temporary]) {
  mkdirSync(folder, { recursive: true });
}
writeFileSync(join(granted, "inside.txt"), "inside-content");
writeFileSync(join(granted, "profile", "Cookies"), "cookie-content");
writeFileSync(join(readOnly, "readable.txt"), "readable-content");
writeFileSync(join(outside, "secret.txt"), "outside-secret");
const homeFile = join(home, `octant-confine-smoke-${randomBytes(6).toString("hex")}.txt`);
writeFileSync(homeFile, "home-secret");

const port = makeProcessConfinementLive({
  platform: "win32",
  unverifiedWindowsConfinement: { launcherPath, homeDirectory: home },
});

function prepare(
  executable: string,
  args: ReadonlyArray<string>,
  overrides: Partial<ProcessConfinementPrepareInput> = {},
) {
  return port.prepare({
    executable,
    args,
    boundRoot: granted,
    temporaryDirectory: temporary,
    readRoots: [readOnly],
    networkEgress: "none",
    ...overrides,
  });
}

function run(
  executable: string,
  args: ReadonlyArray<string>,
  overrides: Partial<ProcessConfinementPrepareInput> = {},
) {
  const launch = prepare(executable, args, overrides);
  const result = spawnSync(launch.command, [...launch.args], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const results: Array<{ check: string; passed: boolean; detail: string }> = [];
function check(name: string, passed: boolean, detail: unknown) {
  results.push({ check: name, passed, detail: JSON.stringify(detail) });
}

const shell = (line: string) => ["/d", "/c", line];

try {
  const exit = run(cmd, shell("exit 7"));
  check("relays the command's exit code", exit.status === 7, exit);

  const inside = run(cmd, shell(`type "${join(granted, "inside.txt")}"`));
  check(
    "reads inside the bound root",
    inside.status === 0 && inside.stdout.includes("inside-content"),
    inside,
  );

  const readable = run(cmd, shell(`type "${join(readOnly, "readable.txt")}"`));
  check(
    "reads a read root",
    readable.status === 0 && readable.stdout.includes("readable-content"),
    readable,
  );

  const write = run(cmd, shell(`echo written> "${join(granted, "written.txt")}"`));
  check(
    "writes inside the bound root",
    write.status === 0 && existsSync(join(granted, "written.txt")),
    write,
  );

  const readOnlyWrite = run(cmd, shell(`echo refused> "${join(readOnly, "refused.txt")}"`));
  check(
    "refuses a write to a read root",
    readOnlyWrite.status !== 0 && !existsSync(join(readOnly, "refused.txt")),
    readOnlyWrite,
  );

  const outsideRead = run(cmd, shell(`type "${join(outside, "secret.txt")}"`));
  check(
    "refuses a folder it was not granted",
    outsideRead.status !== 0 && !outsideRead.stdout.includes("outside-secret"),
    outsideRead,
  );

  const homeRead = run(cmd, shell(`type "${homeFile}"`));
  check(
    "refuses a file in the person's home folder",
    homeRead.status !== 0 && !homeRead.stdout.includes("home-secret"),
    homeRead,
  );

  const cookies = run(cmd, shell(`type "${join(granted, "profile", "Cookies")}"`));
  check(
    "denies a browser store found beneath a grant",
    cookies.status !== 0 && !cookies.stdout.includes("cookie-content"),
    cookies,
  );

  const nested = run(cmd, shell("cmd /d /c echo nested-ran"));
  check(
    "lets a launch that may create processes start a child",
    nested.stdout.includes("nested-ran"),
    nested,
  );
  const noChild = run(cmd, shell("cmd /d /c echo nested-ran"), { allowProcessFork: false });
  check(
    "refuses a child to a launch that may create no process",
    !noChild.stdout.includes("nested-ran"),
    noChild,
  );

  const offline = run(curl, ["-s", "-m", "15", "--head", "-o", "NUL", "https://example.com"]);
  check("reaches no network with no capability", offline.status !== 0, offline);
  const online = run(curl, ["-s", "-m", "15", "--head", "-o", "NUL", "https://example.com"], {
    networkEgress: "allow",
  });
  check("reaches the internet with the client capability", online.status === 0, online);

  const grantVisible = run(cmd, shell(`icacls "${granted}"`));
  check(
    "names the container in the bound root's DACL while it runs",
    /Octant\.Confined\.|S-1-15-2-\d+-\d+/u.test(grantVisible.stdout),
    grantVisible,
  );
  const afterwards = spawnSync("icacls", [granted], { encoding: "utf8" });
  check(
    "removes the container's ACE when the command ends",
    afterwards.status === 0 && !/Octant\.Confined\.|S-1-15-2-\d+-\d+/u.test(afterwards.stdout),
    afterwards.stdout,
  );

  const marker = `octant-confine-${randomBytes(6).toString("hex")}`;
  const held = prepare(cmd, ["/d", "/c", "cmd", "/d", "/c", `set /p OCTANT_WAIT= & rem ${marker}`]);
  const launcher = spawn(held.command, [...held.args], { stdio: ["pipe", "ignore", "ignore"] });
  const markedProcesses = () =>
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `@(Get-CimInstance Win32_Process -Filter "Name='cmd.exe' AND CommandLine LIKE '%${marker}%'").Count`,
      ],
      { encoding: "utf8" },
    ).stdout.trim();
  let started = "0";
  for (let attempt = 0; attempt < 30 && started === "0"; attempt += 1) {
    await new Promise((done) => setTimeout(done, 500));
    started = markedProcesses();
  }
  launcher.kill();
  let remaining = started;
  for (let attempt = 0; attempt < 20 && remaining !== "0"; attempt += 1) {
    await new Promise((done) => setTimeout(done, 500));
    remaining = markedProcesses();
  }
  check(
    "ends the command's whole process tree when the launcher is killed",
    started !== "0" && remaining === "0",
    { started, remaining },
  );
} finally {
  rmSync(homeFile, { force: true });
  rmSync(root, { recursive: true, force: true });
}

for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.check}: ${result.detail}`);
}
if (results.some((result) => !result.passed)) process.exit(1);
