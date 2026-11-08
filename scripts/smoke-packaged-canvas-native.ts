import { Schema } from "effect";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
  const nativeControllerPath = process.env.OCTANT_QA_NATIVE_CONTROLLER;
  if (nativeControllerPath === undefined) throw Error("Supply the built owned native controller.");
  await runBoundedCommand(nativeControllerPath, ["preflight"], process.env, 5000);
  const artifacts = resolve(process.env.OCTANT_QA_OUTPUT ?? "/tmp/octant-packaged-canvas-native");
  const root = await mkdtemp(join(tmpdir(), "octant-canvas-native."));
  let bundle: string | undefined;
  let app: ReturnType<typeof spawnPackagedApplication> | undefined;
  let watchdog: ChildProcess | undefined;
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
      ...(process.env.RUNNER_TRACKING_ID === undefined
        ? {}
        : { RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID }),
    };
    const seed = await runBoundedCommand(
      process.execPath,
      [
        "scripts/seed-canvas-fixtures.ts",
        "--data-dir",
        join(root, "data"),
        "--fixture",
        "document",
      ],
      { ...env, OCTANT_DATA_DIR: join(root, "seed-controller") },
      30_000,
    );
    await writeFile(join(artifacts, "seeded-canvas.txt"), seed);
    app = spawnPackagedApplication({ executable, env });
    pid = app.child.pid;
    if (pid === undefined) throw Error("No owned packaged application process.");
    const ownPid = pid;
    // The app is detached. A second finite owner stops its exact process group
    // if this controller crashes before its normal finally block can run.
    watchdog = spawn(
      process.execPath,
      [
        "-e",
        String.raw`
const owner = Number(process.env.OCTANT_SMOKE_OWNER_PID);
const group = Number(process.env.OCTANT_SMOKE_APP_PID);
const deadline = Date.now() + 120000;
if (!Number.isSafeInteger(owner) || owner < 2 || !Number.isSafeInteger(group) || group < 2) process.exit(1);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; } };
const signal = value => { try { process.kill(-group, value); } catch {} };
const timer = setInterval(() => {
  if (alive(owner) && alive(group) && alive(-group) && Date.now() < deadline) return;
  clearInterval(timer);
  if (!alive(-group)) process.exit(0);
  signal("SIGTERM");
  setTimeout(() => { signal("SIGKILL"); process.exit(0); }, 1000);
}, 100);
`,
      ],
      {
        detached: true,
        env: {
          ...env,
          OCTANT_SMOKE_OWNER_PID: String(process.pid),
          OCTANT_SMOKE_APP_PID: String(ownPid),
        },
        stdio: "ignore",
      },
    );
    const Snapshot = Schema.Struct({
      pid: Schema.Number,
      windowId: Schema.Number,
      texts: Schema.Array(Schema.Struct({ text: Schema.String })),
    });
    const decodeSnapshot = Schema.decodeUnknownSync(Snapshot);
    const hasText = (snapshot: typeof Snapshot.Type, value: string) =>
      snapshot.texts.some((row) => row.text.toLowerCase().includes(value.toLowerCase()));
    let lastNativeError = "";
    const observeUntil = async (
      stage: string,
      accept: (snapshot: typeof Snapshot.Type) => boolean,
    ) => {
      const deadline = Date.now() + 20_000;
      while (!controller.signal.aborted && Date.now() < deadline) {
        try {
          const raw = await runBoundedCommand(
            nativeControllerPath,
            ["observe", String(ownPid), join(artifacts, `${stage}.png`), stage],
            process.env,
            8000,
          );
          await writeFile(join(artifacts, `${stage}.json`), raw);
          const snapshot = decodeSnapshot(JSON.parse(raw));
          if (snapshot.pid !== ownPid) throw Error("The observation belongs to another process.");
          if (accept(snapshot)) return snapshot;
        } catch (error) {
          lastNativeError =
            error instanceof Error ? error.message.slice(-1200) : "Native observation failed.";
        }
        await pause(150);
      }
      await writeFile(join(artifacts, "native-controller-diagnostic.txt"), lastNativeError);
      throw Error(`The real packaged ${stage} state was not observed.`);
    };
    await observeUntil("primary-window", (snapshot) => hasText(snapshot, "Welcome to Octant"));
    await runBoundedCommand(
      nativeControllerPath,
      ["click", String(ownPid), join(artifacts, "skip-setup-target.png"), "Skip setup"],
      process.env,
      8000,
    );
    await observeUntil(
      "after-skip",
      (snapshot) => snapshot.texts.length > 0 && !hasText(snapshot, "Welcome to Octant"),
    );
    await runBoundedCommand(
      nativeControllerPath,
      ["settings", String(ownPid), join(artifacts, "before-settings.png"), "Settings"],
      process.env,
      8000,
    );
    await observeUntil(
      "settings",
      (snapshot) =>
        hasText(snapshot, "Settings") &&
        hasText(snapshot, "Choose app-wide defaults, updates, and network behavior."),
    );
    await runBoundedCommand(
      nativeControllerPath,
      ["click", String(ownPid), join(artifacts, "back-to-app-target.png"), "Back to app"],
      process.env,
      8000,
    );
    await observeUntil("fixture-project", (snapshot) => hasText(snapshot, "Canvas fixtures"));
    await runBoundedCommand(
      nativeControllerPath,
      ["click", String(ownPid), join(artifacts, "fixture-project-target.png"), "Canvas fixtures"],
      process.env,
      8000,
    );
    await observeUntil(
      "fixture-canvas",
      (snapshot) =>
        hasText(snapshot, "Worth watching") &&
        hasText(snapshot, "Signups grew for the third week running."),
    );
    await runBoundedCommand(
      nativeControllerPath,
      ["settings", String(ownPid), join(artifacts, "canvas-before-settings.png"), "Settings"],
      process.env,
      8000,
    );
    await observeUntil("canvas-settings", (snapshot) => hasText(snapshot, "Search settings"));
    await runBoundedCommand(
      nativeControllerPath,
      [
        "fill",
        String(ownPid),
        join(artifacts, "service-search-target.png"),
        "Search settings",
        "Service address",
      ],
      process.env,
      8000,
    );
    await observeUntil("service-search", (snapshot) => hasText(snapshot, "in Permissions"));
    await runBoundedCommand(
      nativeControllerPath,
      ["enter", String(ownPid), join(artifacts, "service-search-result.png"), "Service address"],
      process.env,
      8000,
    );
    await observeUntil(
      "public-link-settings",
      (snapshot) =>
        hasText(snapshot, "Service address") &&
        hasText(snapshot, "Where public links are published"),
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
          if (watchdog !== undefined && !(await exited(watchdog, 2000)))
            throw Error("The finite native cleanup watchdog did not exit.");
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
        watchdogProcessId: watchdog?.pid,
        port,
        nativeInput: "WindowServer image, Vision and CoreGraphics",
        nativeSetupSkip: true,
        nativeSettings: true,
        seededCanvasRendered: true,
        publicLinkSettingsObserved: true,
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
