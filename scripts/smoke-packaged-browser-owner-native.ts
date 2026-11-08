import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createQuitAppleScript } from "./package-desktop";
import {
  cleanupPackagedProcess,
  runBoundedCommand,
  sanitizedPackagedEnvironment,
  spawnPackagedApplication,
  stagePackagedAppBundle,
  waitForProcessCleanup,
} from "./packaged-smoke-process";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const preference = "Keep Browser available without windows";
const ax = String.raw`on run argv
tell application "System Events"
set candidate to first application process whose unix id is (item 1 of argv as integer)
set frontmost of candidate to true
set operation to item 2 of argv
if operation is "count" then return (count of windows of candidate) as text
if operation is "key" then
keystroke (item 3 of argv) using command down
return "sent"
end if
if (count of windows of candidate) is 0 then error "No owned native window."
try
set value of attribute "AXEnhancedUserInterface" of candidate to true
end try
set snapshotRows to {}
repeat with uiElement in (entire contents of first window of candidate)
try
set rowRole to role of uiElement as text
set rowName to ""
set rowDescription to ""
set rowValue to ""
try
set rowName to name of uiElement as text
end try
try
set rowDescription to description of uiElement as text
end try
if rowRole is not "AXSecureTextField" then
try
set rowValue to value of uiElement as text
end try
end if
if operation is "press" and rowName is (item 3 of argv) then
perform action "AXPress" of uiElement
return "pressed"
end if
set end of snapshotRows to (rowRole & " | " & rowName & " | " & rowDescription & " | " & rowValue)
end try
end repeat
if operation is "press" then error "Named owned control unavailable."
set AppleScript's text item delimiters to linefeed
return snapshotRows as text
end tell
end run`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  if (address === null || typeof address === "string") throw Error("No owned fixture port.");
  return address.port;
}
async function exited(child: ChildProcess, bound: number): Promise<boolean> {
  const deadline = Date.now() + bound;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
    await pause(50);
  return child.exitCode !== null || child.signalCode !== null;
}
function groupProcesses(group: number): ReadonlyArray<number> {
  return execFileSync("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8", timeout: 3000 })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, pgid] = line.trim().split(/\s+/).map(Number);
      return pid !== undefined && pgid === group ? [pid] : [];
    });
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error("The owned native Browser lifecycle fixture requires Apple Silicon macOS.");
  if (
    (
      await runBoundedCommand(
        "/usr/bin/osascript",
        ["-e", 'tell application "System Events" to get UI elements enabled'],
        process.env,
        5000,
      )
    ).trim() !== "true"
  )
    throw Error("Native Accessibility unavailable; no permission change attempted.");
  const artifacts = resolve(process.env.OCTANT_QA_OUTPUT ?? "/tmp/octant-browser-owner-native");
  const root = await mkdtemp(join(tmpdir(), "octant-browser-owner-native."));
  const bundle = stagePackagedAppBundle(resolve("out/Octant.app"));
  const port = await freePort();
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  const lifetime = setTimeout(interrupted, 180_000);
  const checks: string[] = [];
  try {
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(root, "home"));
    await mkdir(join(root, "tmp"));
    const env = {
      ...sanitizedPackagedEnvironment(
        { HOME: join(root, "home"), TMPDIR: join(root, "tmp") },
        join(root, "data"),
      ),
      OCTANT_SERVER_PORT: String(port),
      ...(process.env.RUNNER_TRACKING_ID === undefined
        ? {}
        : { RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID }),
    };
    for (const phase of ["initial", "restart"] as const) {
      const app = spawnPackagedApplication({
        executable: join(bundle, "Contents/MacOS/Octant"),
        env,
      });
      const pid = app.child.pid;
      if (pid === undefined) throw Error("Owned app did not start.");
      const watchdog = spawn(
        process.execPath,
        [
          "-e",
          String.raw`
const owner = Number(process.env.OCTANT_QA_OWNER), group = Number(process.env.OCTANT_QA_GROUP);
const deadline = Date.now() + 200000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; } };
const timer = setInterval(() => {
  if (alive(owner) && alive(group) && Date.now() < deadline) return;
  clearInterval(timer);
  if (!alive(-group)) process.exit(0);
  try { process.kill(-group, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-group, "SIGKILL"); } catch {} process.exit(0); }, 1000);
}, 100);`,
        ],
        {
          detached: true,
          env: { ...env, OCTANT_QA_OWNER: String(process.pid), OCTANT_QA_GROUP: String(pid) },
          stdio: "ignore",
        },
      );
      const native = (operation: string, value = "") =>
        runBoundedCommand(
          "/usr/bin/osascript",
          ["-e", ax, String(pid), operation, value],
          process.env,
          6000,
        );
      const wait = async (
        name: string,
        predicate: (snapshot: string) => boolean,
        bound = 12_000,
      ) => {
        const deadline = Date.now() + bound;
        let snapshot = "";
        let lastError = "";
        while (!controller.signal.aborted && Date.now() < deadline) {
          if (app.child.exitCode !== null || app.child.signalCode !== null)
            throw Error("Owned app exited during native inspection.");
          try {
            snapshot = await native("snapshot");
          } catch (error) {
            lastError = error instanceof Error ? error.message.slice(-1200) : "Native read failed.";
          }
          if (predicate(snapshot)) return snapshot;
          await pause(150);
        }
        await writeFile(join(artifacts, `${phase}-${name}-failed-ax.txt`), snapshot);
        await writeFile(join(artifacts, `${phase}-${name}-native-error.txt`), lastError);
        await runBoundedCommand(
          "/usr/sbin/screencapture",
          ["-x", join(artifacts, `${phase}-${name}-failed.png`)],
          process.env,
          5000,
        );
        throw Error(`Native ${name} did not settle. ${lastError}`);
      };
      const capture = async (name: string, snapshot: string) => {
        await writeFile(join(artifacts, `${phase}-${name}-ax.txt`), snapshot);
        await runBoundedCommand(
          "/usr/sbin/screencapture",
          ["-x", join(artifacts, `${phase}-${name}.png`)],
          process.env,
          5000,
        );
      };
      const switchValue = (snapshot: string, value: number) =>
        snapshot
          .split("\n")
          .some((line) => line.includes(preference) && line.trim().endsWith(`| ${value}`));
      const settings = async () => {
        await native("key", ",");
        await wait("settings", (s) => s.includes("Data & storage"));
        await native("press", "Data & storage");
        return wait("preference", (s) => s.includes(preference));
      };
      try {
        if (phase === "initial") {
          await wait(
            "onboarding",
            (s) => s.includes("Welcome to Octant") && s.includes("Skip setup"),
            45_000,
          );
          await native("press", "Skip setup");
          await wait("skip", (s) => s.includes("AXButton") && !s.includes("Welcome to Octant"));
        } else await wait("restarted-window", (s) => s.includes("AXButton"), 45_000);
        let snapshot = await settings();
        await capture("preference", snapshot);
        if (!switchValue(snapshot, phase === "initial" ? 0 : 1))
          throw Error("Native preference value differs from expected persisted value.");
        checks.push(phase === "initial" ? "default-off" : "opt-in-survives-host-restart");
        if (phase === "initial") {
          await native("press", preference);
          snapshot = await wait("opt-in", (s) => switchValue(s, 1));
          await capture("opt-in", snapshot);
          await native("key", "w");
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && (await native("count")).trim() !== "0") await pause(100);
          if (
            (await native("count")).trim() !== "0" ||
            app.child.exitCode !== null ||
            app.child.signalCode !== null
          )
            throw Error("Last-window close did not retain the owned macOS process.");
          checks.push("last-window-closed-same-process-alive");
          await runBoundedCommand("/usr/bin/open", ["-a", bundle], process.env, 5000);
          await wait("reopen", (s) => s.includes("AXButton"));
          snapshot = await settings();
          if (!switchValue(snapshot, 1)) throw Error("Reopened window lost opt-in.");
          await capture("reopened", snapshot);
          checks.push("reopened-same-process-preference-retained");
        } else {
          await native("press", preference);
          snapshot = await wait("opt-out", (s) => switchValue(s, 0));
          await capture("opt-out", snapshot);
          checks.push("switch-off-through-native-settings");
        }
        await native("key", "q");
        if (!(await exited(app.child, 8000)))
          throw Error("Explicit native Quit did not exit the host.");
        checks.push(`${phase}-explicit-quit-exited`);
      } finally {
        await cleanupPackagedProcess({
          child: app.child,
          requestQuit: () =>
            runBoundedCommand(
              "/usr/bin/osascript",
              ["-e", createQuitAppleScript(bundle)],
              process.env,
              3000,
            ).then(() => undefined),
          waitForExit: (_child, bound) => exited(app.child, bound),
          signalGroup: (group, signal) => {
            if (group !== pid) throw Error("Unowned process group.");
            try {
              process.kill(-group, signal);
            } catch (e) {
              if (!(typeof e === "object" && e !== null && "code" in e && e.code === "ESRCH"))
                throw e;
            }
          },
          waitForServerCleanup: () =>
            waitForProcessCleanup(
              async () => {
                const response = await fetch(`http://127.0.0.1:${port}/health`, {
                  signal: AbortSignal.timeout(300),
                }).catch(() => undefined);
                if (response !== undefined) throw Error("Owned host listener remains.");
              },
              { timeoutMs: 3000 },
            ),
          assertNoProcesses: async () => {
            if (groupProcesses(pid).length !== 0 || !(await exited(watchdog, 2000)))
              throw Error("Owned app/watchdog cleanup incomplete.");
          },
          gracefulTimeoutMs: 3000,
          forceTimeoutMs: 2000,
        });
      }
    }
    if (controller.signal.aborted) throw Error("Owned native lifecycle interrupted.");
    await writeFile(
      join(artifacts, "lifecycle-evidence.json"),
      JSON.stringify(
        {
          checks,
          nativeUi: true,
          cleanup: "verified",
          activeExecutionLease: "not-run",
          profileCookieContinuity: "not-run",
          personalAccount: false,
          productionDebuggingUnchanged: true,
        },
        null,
        2,
      ),
    );
  } finally {
    clearTimeout(lifetime);
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
    await rm(root, { recursive: true, force: true });
    if (bundle.startsWith(join(tmpdir(), "octant-packaged-app.")))
      await rm(dirname(bundle), { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Native Browser owner smoke failed.");
  process.exitCode = 1;
});
