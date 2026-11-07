import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { createQuitAppleScript } from "./package-desktop";
import {
  cleanupPackagedProcess,
  runBoundedCommand,
  sanitizedPackagedEnvironment,
  spawnPackagedApplication,
  stagePackagedAppBundle,
  waitForProcessCleanup,
} from "./packaged-smoke-process";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  if (address === null || typeof address === "string") throw Error("No fixture port.");
  return address.port;
}

async function exited(child: ChildProcess, milliseconds: number): Promise<boolean> {
  const until = Date.now() + milliseconds;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until)
    await pause(50);
  return child.exitCode !== null || child.signalCode !== null;
}

function groupProcesses(group: number): ReadonlyArray<number> {
  return execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    timeout: 3000,
  })
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, pgid] = line.trim().split(/\s+/).map(Number);
      return pid !== undefined && pgid === group ? [pid] : [];
    });
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error("Packaged native Canvas validation requires Apple Silicon macOS.");
  const available = await runBoundedCommand(
    "/usr/bin/osascript",
    ["-e", 'tell application "System Events" to get UI elements enabled'],
    process.env,
    5000,
  );
  if (available.trim() !== "true")
    throw Error("Native Accessibility is unavailable. No permission changes were attempted.");
  const artifacts = resolve(process.env.OCTANT_QA_OUTPUT ?? "/tmp/octant-packaged-canvas-native");
  const root = await mkdtemp(join(tmpdir(), "octant-canvas-native."));
  let bundle: string | undefined;
  let app: ReturnType<typeof spawnPackagedApplication> | undefined;
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  const timer = setTimeout(interrupted, 90_000);
  let verified = false;
  let cleanupVerified = false;
  let pid: number | undefined;
  let port: number | undefined;
  try {
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(root, "home"));
    await mkdir(join(root, "tmp"));
    port = await freePort();
    bundle = stagePackagedAppBundle(resolve("out/Octant.app"));
    const executable = join(bundle, "Contents/MacOS/Octant");
    const env = {
      ...sanitizedPackagedEnvironment(
        { HOME: join(root, "home"), TMPDIR: join(root, "tmp") },
        join(root, "data"),
      ),
      OCTANT_SERVER_PORT: String(port),
    };
    app = spawnPackagedApplication({ executable, env });
    pid = app.child.pid;
    if (pid === undefined) throw Error("No owned packaged application process.");
    const ownPid = pid;
    const snapshotScript = String.raw`on run argv
tell application "System Events"
set candidate to first application process whose unix id is (item 1 of argv as integer)
set frontmost of candidate to true
if (count of windows of candidate) is 0 then error "Packaged window is not ready."
try
set value of attribute "AXEnhancedUserInterface" of candidate to true
end try
set lines to {}
repeat with element in (entire contents of first window of candidate)
try
set end of lines to ((role of element as text) & " | " & (name of element as text) & " | " & (description of element as text) & " | " & (value of element as text))
end try
end repeat
set AppleScript's text item delimiters to linefeed
return lines as text
end tell
end run`;
    let snapshot = "";
    const deadline = Date.now() + 45_000;
    while (!controller.signal.aborted && Date.now() < deadline) {
      if (app.child.exitCode !== null || app.child.signalCode !== null)
        throw Error("The packaged application exited before primary-window inspection.");
      try {
        snapshot = await runBoundedCommand(
          "/usr/bin/osascript",
          ["-e", snapshotScript, String(ownPid)],
          process.env,
          6000,
        );
        if (snapshot.includes("AXButton")) break;
      } catch {
        // Poll only this owned application's native window while it starts.
      }
      await pause(200);
    }
    if (controller.signal.aborted || !snapshot.includes("AXButton"))
      throw Error("The real packaged primary window exposed no usable native controls.");
    await writeFile(join(artifacts, "primary-window-ax.txt"), snapshot);
    await runBoundedCommand(
      "/usr/sbin/screencapture",
      ["-x", join(artifacts, "primary-window.png")],
      process.env,
      5000,
    );
    if (controller.signal.aborted) throw Error("Native window observation was interrupted.");
    verified = true;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
    if (app !== undefined && pid !== undefined && bundle !== undefined) {
      const ownPid = pid;
      const ownedApp = app;
      const ownedBundle = bundle;
      const ownedPort = port;
      await cleanupPackagedProcess({
        child: ownedApp.child,
        requestQuit: () =>
          runBoundedCommand(
            "/usr/bin/osascript",
            ["-e", createQuitAppleScript(ownedBundle)],
            process.env,
            3000,
          ).then(() => undefined),
        waitForExit: (_child, timeout) => exited(ownedApp.child, timeout),
        signalGroup: (group, signal) => {
          if (group !== ownPid) throw Error("Refusing an unowned process group.");
          try {
            process.kill(-group, signal);
          } catch (error) {
            if (
              !(
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ESRCH"
              )
            )
              throw error;
          }
        },
        waitForServerCleanup: async () => {
          if (ownedPort === undefined) return;
          await waitForProcessCleanup(
            async () => {
              const response = await fetch(`http://127.0.0.1:${ownedPort}/health`, {
                signal: AbortSignal.timeout(300),
              }).catch(() => undefined);
              if (response !== undefined) throw Error("The owned listener remains available.");
            },
            { timeoutMs: 3000 },
          );
        },
        assertNoProcesses: async () => {
          if (groupProcesses(ownPid).length !== 0) throw Error("Owned native processes remain.");
        },
        gracefulTimeoutMs: 3000,
        forceTimeoutMs: 2000,
      });
      cleanupVerified = true;
    }
    await rm(root, { recursive: true, force: true });
    if (bundle !== undefined && bundle.startsWith(join(tmpdir(), "octant-packaged-app.")))
      await rm(dirname(bundle), { recursive: true, force: true });
  }
  if (controller.signal.aborted || !verified || !cleanupVerified)
    throw Error("Native window proof or cleanup is incomplete.");
  await writeFile(
    join(artifacts, "native-window-evidence.json"),
    JSON.stringify(
      {
        stage: "packaged-primary-window",
        result: "observed",
        processId: pid,
        port,
        nativeAccessibility: true,
        productionDebuggingUnchanged: true,
        cleanup: "verified",
        publishAcceptance: "not-run",
        pairedAcceptance: "not-run",
        personalAccount: false,
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Packaged native smoke failed.");
  process.exitCode = 1;
});
