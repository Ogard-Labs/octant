import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactHostRuntimeText } from "@octant/host-runtime";
import { openReadOnlySqlite } from "../apps/server/src/persistence/sqlitePort";
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
set operation to item 2 of argv
if operation is "registered" then return (unix id of candidate) as text
if operation is "initialize" then
try
set value of attribute "AXManualAccessibility" of candidate to true
end try
try
set value of attribute "AXEnhancedUserInterface" of candidate to true
end try
set frontmost of candidate to true
return "initialized"
end if
if operation is "focus" then
set frontmost of candidate to true
return "focused"
end if
if operation is "key" then
set frontmost of candidate to true
keystroke (item 3 of argv) using command down
return "sent"
end if
error "Unsupported captured-process operation."
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
  const visualStateImages: string[] = [];
  const persistedReadings: Array<{
    readonly checkpoint: string;
    readonly value: boolean | null;
    readonly globalSequence: number | null;
  }> = [];
  const persistedPreference = () => {
    const database = openReadOnlySqlite(join(root, "data", "octant.sqlite3"));
    try {
      // Read only this preference from the authoritative UI-generated event.
      // No journal payload, other settings or private data leave this query.
      const rows = database.all(`SELECT
        json_type(payload_json, '$.settings.persistentBrowserOwner') AS preference_type,
        json_extract(payload_json, '$.settings.persistentBrowserOwner') AS preference_value,
        global_sequence FROM event_journal
        WHERE event_name = 'shell.settings-replaced' AND aggregate_type = 'shell-settings'
          AND aggregate_id = '00000000-0000-4000-8000-000000000001'
        ORDER BY global_sequence DESC LIMIT 1`);
      const row = rows[0];
      if (row === undefined) return { value: null, globalSequence: null };
      if (
        typeof row !== "object" ||
        row === null ||
        !("preference_type" in row) ||
        !("preference_value" in row) ||
        !("global_sequence" in row) ||
        typeof row.global_sequence !== "number" ||
        !Number.isSafeInteger(row.global_sequence) ||
        row.global_sequence <= 0
      )
        throw Error("Owned preference journal read has an unexpected shape.");
      if (row.preference_type === "true" && row.preference_value === 1)
        return { value: true, globalSequence: row.global_sequence };
      if (row.preference_type === "false" && row.preference_value === 0)
        return { value: false, globalSequence: row.global_sequence };
      throw Error("Owned preference journal does not contain a strict boolean.");
    } finally {
      database.close();
    }
  };
  const recordPersisted = async (checkpoint: string, expected?: boolean) => {
    const deadline = Date.now() + 3000;
    while (!controller.signal.aborted) {
      const reading = persistedPreference();
      if (expected === undefined || reading.value === expected) {
        persistedReadings.push({ checkpoint, ...reading });
        await writeFile(
          join(artifacts, "preference-read-only-evidence.json"),
          JSON.stringify(persistedReadings, null, 2),
        );
        return;
      }
      if (Date.now() >= deadline) break;
      await pause(100);
    }
    throw Error(`Owned UI preference did not persist at ${checkpoint}.`);
  };
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
    const sdkExecutable = join(root, "ax-controller");
    await runBoundedCommand(
      "/usr/bin/xcrun",
      [
        "swiftc",
        fileURLToPath(new URL("./packaged-browser-owner-ax.swift", import.meta.url)),
        "-o",
        sdkExecutable,
      ],
      process.env,
      30_000,
    );
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
      const systemEvents = (operation: string, value = "") =>
        runBoundedCommand(
          "/usr/bin/osascript",
          ["-e", ax, String(pid), operation, value],
          process.env,
          6000,
        );
      const sdk = (
        mode: "diagnostic" | "read" | "click" | "reveal" | "reopen" | "dock-read" | "quit-hint",
        value?: string,
      ) =>
        runBoundedCommand(
          sdkExecutable,
          [String(pid), bundle, mode, ...(value === undefined ? [] : [value])],
          process.env,
          6000,
        );
      let clickSequence = 0;
      let revealSequence = 0;
      const native = async (operation: string, value = ""): Promise<string> => {
        if (
          operation !== "snapshot" &&
          operation !== "count" &&
          operation !== "click" &&
          operation !== "reveal" &&
          operation !== "reopen"
        )
          return systemEvents(operation, value);
        if (operation === "click" || operation === "reveal") await systemEvents("focus");
        const raw = await sdk(
          operation === "click" || operation === "reveal" || operation === "reopen"
            ? operation
            : "read",
          operation === "click" || operation === "reveal" ? value : undefined,
        );
        await writeFile(
          join(
            artifacts,
            operation === "click"
              ? `${phase}-sdk-native-click-${++clickSequence}.json`
              : operation === "reveal"
                ? `${phase}-sdk-reveal-${++revealSequence}.json`
                : `${phase}-sdk-last-${operation}.json`,
          ),
          raw,
        );
        const decoded: unknown = JSON.parse(raw);
        const record = (item: unknown): item is Readonly<Record<string, unknown>> =>
          typeof item === "object" && item !== null && !Array.isArray(item);
        if (
          !record(decoded) ||
          decoded.capturedPid !== pid ||
          decoded.treeIdentityMatched !== true ||
          decoded.nativeAxTrusted !== true ||
          decoded.windowsError !== 0 ||
          typeof decoded.axWindowCount !== "number" ||
          !Number.isSafeInteger(decoded.axWindowCount) ||
          decoded.axWindowCount < 0
        )
          throw Error("Native SDK refused the captured window identity or read.");
        if (operation === "count") return String(decoded.axWindowCount);
        if (
          decoded.treeTruncated !== false ||
          decoded.treeReadErrors !== 0 ||
          !Array.isArray(decoded.interactiveControls)
        )
          throw Error("Native SDK control tree is incomplete.");
        if (operation === "reopen") {
          if (
            !record(decoded.action) ||
            decoded.action.status !== "acknowledged" ||
            decoded.action.method !== "PID-targeted-reopen" ||
            decoded.action.targetPid !== pid ||
            decoded.action.permissionStatus !== 0 ||
            decoded.action.nativeError !== 0
          )
            throw Error("Native reopen was refused or uncertain. It is never retried.");
          return "acknowledged";
        }
        if (operation === "reveal") {
          if (
            !record(decoded.action) ||
            decoded.action.status !== "acknowledged" ||
            decoded.action.method !== "AXScrollToVisible" ||
            decoded.action.matches !== 1
          )
            throw Error(`Native SDK refused to reveal the exact owned control: ${value}.`);
          await pause(200);
          return "scroll-requested";
        }
        if (operation === "click") {
          if (
            !record(decoded.action) ||
            decoded.action.status !== "dispatched" ||
            decoded.action.method !== "native-click" ||
            decoded.action.matches !== 1
          )
            throw Error(
              `Native SDK refused the single enabled owned control: ${value}. No action is retried.`,
            );
          return "dispatched";
        }
        return decoded.interactiveControls
          .map((control: unknown) => {
            if (
              !record(control) ||
              typeof control.role !== "string" ||
              typeof control.title !== "string" ||
              typeof control.description !== "string" ||
              (control.value !== undefined && control.value !== 0 && control.value !== 1)
            )
              throw Error("Invalid native SDK control shape.");
            return `${control.role} | ${control.title} | ${control.description} | ${control.value ?? ""}`;
          })
          .join("\n");
      };
      const diagnose = async (name: string) => {
        const script = String.raw`on run argv
tell application "System Events"
set candidate to first application process whose unix id is (item 1 of argv as integer)
set diagnosticRows to {"captured PID: " & (unix id of candidate as text)}
repeat with attributeName in {"AXManualAccessibility", "AXEnhancedUserInterface"}
try
set value of attribute attributeName of candidate to true
set end of diagnosticRows to ((attributeName as text) & " set succeeded")
on error errorText number errorNumber
set end of diagnosticRows to ((attributeName as text) & " set failed: " & errorNumber & " " & errorText)
end try
end repeat
try
set end of diagnosticRows to ("role: " & (role of candidate as text))
end try
try
set end of diagnosticRows to ("attributes: " & (name of every attribute of candidate as text))
end try
try
set end of diagnosticRows to ("windows: " & (count of windows of candidate as text))
end try
set AppleScript's text item delimiters to linefeed
return diagnosticRows as text
end tell
end run`;
        try {
          await writeFile(
            join(artifacts, `${phase}-${name}-system-events.txt`),
            await runBoundedCommand(
              "/usr/bin/osascript",
              ["-e", script, String(pid)],
              process.env,
              6000,
            ),
          );
        } catch (error) {
          await writeFile(
            join(artifacts, `${phase}-${name}-system-events.txt`),
            error instanceof Error ? error.message : "System Events diagnostic failed.",
          );
        }
        try {
          await writeFile(
            join(artifacts, `${phase}-${name}-native-ax.json`),
            await sdk("diagnostic"),
          );
        } catch (error) {
          await writeFile(
            join(artifacts, `${phase}-${name}-native-ax-error.txt`),
            error instanceof Error ? error.message : "Native AX diagnostic failed.",
          );
        }
      };
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
        await diagnose(name);
        await runBoundedCommand(
          "/usr/sbin/screencapture",
          ["-x", join(artifacts, `${phase}-${name}-failed.png`)],
          process.env,
          5000,
        );
        throw Error(`Native ${name} did not settle. ${lastError}`);
      };
      const capture = async (name: string, snapshot: string) => {
        await pause(200);
        await writeFile(join(artifacts, `${phase}-${name}-ax.txt`), snapshot);
        await runBoundedCommand(
          "/usr/sbin/screencapture",
          ["-x", join(artifacts, `${phase}-${name}.png`)],
          process.env,
          5000,
        );
        visualStateImages.push(`${phase}-${name}.png`);
      };
      const settings = async () => {
        await wait("app-settings-entry", (s) => s.includes("AXButton |  | Settings |"));
        await native("click", "Settings");
        await wait("settings", (s) => s.includes("Data & storage"));
        await native("reveal", "Data & storage");
        await native("click", "Data & storage");
        await wait("preference", (s) => s.includes(preference));
        await native("reveal", preference);
        // This method records rendered state for independent visual review.
        // An empty native AXValue never becomes a checked bit.
        return wait("visible-preference", (s) => s.includes(preference));
      };
      try {
        // Accessibility initialization can rebuild Electron's AX tree. Do it
        // once after process registration; observations must let that tree settle.
        const registrationDeadline = Date.now() + 12_000;
        let registered = false;
        while (!controller.signal.aborted && Date.now() < registrationDeadline) {
          try {
            if ((await native("registered")).trim() === String(pid)) {
              registered = true;
              break;
            }
          } catch {
            /* The captured process has not registered its application yet. */
          }
          await pause(100);
        }
        if (!registered) throw Error("Captured native application did not register.");
        await native("initialize");
        if (phase === "initial") {
          await wait(
            "onboarding",
            (s) => s.includes("AXButton") && s.includes("Skip setup"),
            45_000,
          );
          await native("click", "Skip setup");
          await wait("skip", (s) => s.includes("AXButton") && !s.includes("Skip setup"));
        } else
          await wait("restarted-window", (s) => s.includes("AXButton |  | Settings |"), 45_000);
        let snapshot = await settings();
        await capture("preference", snapshot);
        await recordPersisted(`${phase}-before-toggle`, phase === "restart" ? true : undefined);
        checks.push(`${phase}-preference-captured-for-independent-visual-review`);
        if (phase === "initial") {
          await native("click", preference);
          await recordPersisted("initial-after-opt-in", true);
          snapshot = await native("snapshot");
          await capture("opt-in", snapshot);
          checks.push("single-ui-opt-in-persisted-in-owned-journal");
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
          try {
            await writeFile(
              join(artifacts, "initial-read-only-dock-feasibility.json"),
              await sdk("dock-read"),
            );
          } catch {
            await writeFile(
              join(artifacts, "initial-read-only-dock-feasibility-error.txt"),
              "Bounded read-only Dock observation unavailable; no interaction attempted.",
            );
          }
          // The separate reopen fixture was refused by the non-prompting
          // permission preflight (-1744). Do not retry or substitute an action.
          // Continue only the independent Quit/restart criteria below.
        } else {
          await native("click", preference);
          await recordPersisted("restart-after-opt-out", false);
          snapshot = await native("snapshot");
          await capture("opt-out", snapshot);
          checks.push("single-ui-opt-out-persisted-in-owned-journal");
        }
        // The normal visible-window shortcut asks for a second press. With no
        // window, the first press quits directly because no hint can be shown.
        if (phase === "restart") {
          const confirmationDeadline = Date.now() + 1100;
          await native("key", "q");
          let observed = false;
          while (Date.now() < confirmationDeadline - 300 && !controller.signal.aborted) {
            const raw = await sdk("quit-hint");
            await writeFile(join(artifacts, "restart-quit-confirmation.json"), raw);
            const hint: unknown = JSON.parse(raw);
            if (
              typeof hint === "object" &&
              hint !== null &&
              "capturedPid" in hint &&
              hint.capturedPid === pid &&
              "treeIdentityMatched" in hint &&
              hint.treeIdentityMatched === true &&
              "treeTruncated" in hint &&
              hint.treeTruncated === false &&
              "treeReadErrors" in hint &&
              hint.treeReadErrors === 0 &&
              "quitHintObserved" in hint &&
              hint.quitHintObserved === true
            ) {
              observed = true;
              break;
            }
            await pause(30);
          }
          if (!observed || Date.now() >= confirmationDeadline - 300)
            throw Error(
              "Normal native Quit confirmation was not observed within its bound; no second press sent.",
            );
          await native("key", "q");
          checks.push("normal-visible-window-quit-hint-observed-before-confirmation");
        } else await native("key", "q");
        if (!(await exited(app.child, 8000)))
          throw Error("Explicit native Quit did not exit the host.");
        checks.push(`${phase}-explicit-quit-exited`);
      } finally {
        try {
          await writeFile(
            join(artifacts, `${phase}-app-output.txt`),
            redactHostRuntimeText(app.outputTail()),
          );
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
    }
    if (controller.signal.aborted) throw Error("Owned native lifecycle interrupted.");
    await writeFile(
      join(artifacts, "lifecycle-evidence.json"),
      JSON.stringify(
        {
          checks,
          nativeUi: true,
          nativeInputMethod: "single native click at fresh owned AX bounds",
          stateVerificationMethod:
            "rendered screenshots with read-only preference journal corroboration",
          nativeAxCheckedState: "unavailable-empty-CFString",
          stateChecks: "pending independent visual review",
          requiredCriteriaComplete: false,
          lastWindowReopen: {
            status: "incomplete",
            reason: "prior owned fixture's non-prompting permission preflight refused",
            nativePermissionStatus: -1744,
            newAttempt: false,
          },
          visualStateImages,
          persistedReadings,
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
    throw Error(
      "Native lifecycle remains incomplete: last-window reopen was not exercised; prior permission refusal -1744 retained.",
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
