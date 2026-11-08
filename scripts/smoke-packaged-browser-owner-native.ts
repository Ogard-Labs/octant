import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactHostRuntimeText } from "@octant/host-runtime";
import { openReadOnlySqlite } from "../apps/server/src/persistence/sqlitePort";
import { createQuitAppleScript } from "./package-desktop";
import {
  OWNED_BROWSER_FIXTURE_NAME,
  startOwnedBrowserProvider,
} from "./packaged-browser-owner-provider";
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
if operation is "escape" then
set frontmost of candidate to true
key code 53
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

async function recordOwnedPickerDirectoryCleanup(root: string, artifacts: string): Promise<void> {
  const status = await lstat(root).then(
    () => "present",
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
        ? "absent"
        : "unknown",
  );
  await writeFile(
    join(artifacts, "project-picker-fixture-cleanup.json"),
    JSON.stringify({
      ownedFixtureDirectoryAbsent: status === "absent",
      inspection: status,
    }),
  );
  if (status !== "absent") throw Error("Owned picker fixture directory cleanup is unconfirmed.");
}

async function main(): Promise<void> {
  const projectPickerDiscovery = process.argv.slice(2).join(" ") === "--project-picker-discovery";
  const providerSetup =
    projectPickerDiscovery || process.argv.slice(2).join(" ") === "--provider-setup";
  if (process.argv.length > 2 && !providerSetup) throw Error("Unknown owned native scenario.");
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
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  const lifetime = setTimeout(interrupted, 180_000);
  let provider: Awaited<ReturnType<typeof startOwnedBrowserProvider>> | undefined;
  let retainOwnedFilesForWatchdog = false;
  const checks: string[] = [];
  const visualStateImages: string[] = [];
  let ownedProjectBindingVerified = false;
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
    if (providerSetup)
      provider = await startOwnedBrowserProvider({
        signal: controller.signal,
        lifetimeMs: 180_000,
      });
    const port = await freePort();
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(root, "home"));
    await mkdir(join(root, "tmp"));
    if (projectPickerDiscovery) await mkdir(join(root, "home", "owned-browser-project"));
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
    const ownWatchdog = (pid: number, label: string, lifetimeMs = 200_000) => {
      const watchdog = spawn(
        process.execPath,
        [
          "-e",
          String.raw`
const { spawnSync } = require("node:child_process");
const { writeFileSync, rmSync } = require("node:fs");
const group = Number(process.env.OCTANT_QA_GROUP);
const deadline = Date.now() + Number(process.env.OCTANT_QA_LIFETIME_MS);
let finishing = false;
const finish = (removeOwnedFiles = false) => {
  if (finishing) return;
  finishing = true;
  clearInterval(timer);
  try {
    const result = spawnSync(process.env.OCTANT_QA_AX_EXECUTABLE,
      [String(group), process.env.OCTANT_QA_BUNDLE, "bundle-cleanup"],
      { env: { ...process.env, TMPDIR: process.env.OCTANT_QA_STAGE_TMPDIR }, timeout: 6000,
        killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 256000 });
    const receipt = JSON.parse(result.stdout).cleanupObservation;
    writeFileSync(process.env.OCTANT_QA_WATCHDOG_RECEIPT, JSON.stringify(receipt));
    if (result.status !== 0 || receipt?.status !== "absent" || receipt?.censusComplete !== true) process.exit(1);
    if (removeOwnedFiles) {
      rmSync(process.env.OCTANT_QA_STAGING, { recursive: true, force: true });
      rmSync(process.env.OCTANT_QA_SCRATCH, { recursive: true, force: true });
    }
    process.exit(0);
  } catch { process.exit(1); }
};
const timer = setInterval(() => { if (Date.now() >= deadline) finish(true); }, 100);
// Only the controller holds the pipe's write end. EOF remains reliable even
// when the controller's numeric PID has already been reused.
process.stdin.once("end", () => finish(true));
process.stdin.once("close", () => finish(true));
process.stdin.once("error", () => finish(true));
process.stdin.resume();
process.once("SIGTERM", () => finish(false));
process.once("SIGINT", () => finish(false));`,
        ],
        {
          detached: true,
          env: {
            ...env,
            OCTANT_QA_GROUP: String(pid),
            OCTANT_QA_LIFETIME_MS: String(lifetimeMs),
            OCTANT_QA_AX_EXECUTABLE: sdkExecutable,
            OCTANT_QA_BUNDLE: bundle,
            OCTANT_QA_STAGE_TMPDIR: tmpdir(),
            OCTANT_QA_SCRATCH: root,
            OCTANT_QA_STAGING: dirname(bundle),
            OCTANT_QA_WATCHDOG_RECEIPT: join(artifacts, `${label}-watchdog-exact-cleanup.json`),
          },
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      watchdog.unref();
      return watchdog;
    };
    {
      retainOwnedFilesForWatchdog = true;
      const fixture = spawn(join(bundle, "Contents/Resources/native/octant-code-file-helper"), [], {
        detached: true,
        env,
        stdio: ["pipe", "ignore", "ignore"],
      });
      const fixturePid = fixture.pid;
      if (fixturePid === undefined) throw Error("Owned packaged cleanup fixture did not start.");
      const watchdog = ownWatchdog(fixturePid, "cleanup-fixture", 15_000);
      const kernelCommand = async (mode: "bundle-census" | "bundle-cleanup") => {
        const raw = await runBoundedCommand(
          sdkExecutable,
          [String(fixturePid), bundle, mode],
          process.env,
          6000,
        );
        await writeFile(join(artifacts, `outside-group-fixture-${mode}.json`), raw);
        const decoded: unknown = JSON.parse(raw);
        if (
          typeof decoded !== "object" ||
          decoded === null ||
          !("cleanupObservation" in decoded) ||
          typeof decoded.cleanupObservation !== "object" ||
          decoded.cleanupObservation === null
        )
          throw Error("Owned cleanup fixture has no kernel ownership receipt.");
        return decoded.cleanupObservation;
      };
      try {
        const before = await kernelCommand("bundle-census");
        if (
          !("censusComplete" in before) ||
          before.censusComplete !== true ||
          !("initialOwned" in before) ||
          !Array.isArray(before.initialOwned) ||
          before.initialOwned.length !== 1
        )
          throw Error("Owned cleanup fixture census is incomplete or ambiguous.");
        const identity: unknown = before.initialOwned[0];
        if (
          typeof identity !== "object" ||
          identity === null ||
          !("pid" in identity) ||
          identity.pid !== fixturePid ||
          !("groupPid" in identity) ||
          identity.groupPid !== fixturePid ||
          identity.groupPid === process.pid ||
          !("birthSeconds" in identity) ||
          typeof identity.birthSeconds !== "number" ||
          !Number.isSafeInteger(identity.birthSeconds) ||
          identity.birthSeconds <= 0 ||
          !("birthMicroseconds" in identity) ||
          typeof identity.birthMicroseconds !== "number" ||
          !Number.isSafeInteger(identity.birthMicroseconds) ||
          identity.birthMicroseconds < 0 ||
          identity.birthMicroseconds >= 1_000_000 ||
          !("kernelCanonicalExecutable" in identity) ||
          typeof identity.kernelCanonicalExecutable !== "string" ||
          !identity.kernelCanonicalExecutable.endsWith(
            "/Contents/Resources/native/octant-code-file-helper",
          ) ||
          !("underExactStagedBundle" in identity) ||
          identity.underExactStagedBundle !== true
        )
          throw Error("Owned cleanup fixture kernel birth/path/group is not proven.");
        const after = await kernelCommand("bundle-cleanup");
        if (
          !("status" in after) ||
          after.status !== "absent" ||
          !("censusComplete" in after) ||
          after.censusComplete !== true ||
          !("remainingOwned" in after) ||
          !Array.isArray(after.remainingOwned) ||
          after.remainingOwned.length !== 0 ||
          !("initialOwned" in after) ||
          !Array.isArray(after.initialOwned) ||
          after.initialOwned.length !== 1 ||
          !("signalCount" in after) ||
          typeof after.signalCount !== "number" ||
          !Number.isSafeInteger(after.signalCount) ||
          after.signalCount < 1
        )
          throw Error("Detached packaged helper cleanup did not prove joined kernel absence.");
        const stopped: unknown = after.initialOwned[0];
        if (
          typeof stopped !== "object" ||
          stopped === null ||
          !("pid" in stopped) ||
          stopped.pid !== fixturePid ||
          !("birthSeconds" in stopped) ||
          stopped.birthSeconds !== identity.birthSeconds ||
          !("birthMicroseconds" in stopped) ||
          stopped.birthMicroseconds !== identity.birthMicroseconds ||
          !("kernelCanonicalExecutable" in stopped) ||
          stopped.kernelCanonicalExecutable !== identity.kernelCanonicalExecutable ||
          !(await exited(fixture, 2000)) ||
          groupProcesses(fixturePid).length !== 0
        )
          throw Error("Detached packaged helper identity or join differs from its census.");
        watchdog.kill("SIGTERM");
        if (!(await exited(watchdog, 6000)) || watchdog.exitCode !== 0)
          throw Error("Detached cleanup fixture watchdog did not join.");
        retainOwnedFilesForWatchdog = false;
        checks.push(
          "detached-real-packaged-helper-cleaned-by-kernel-birth-and-executable-before-app-launch",
        );
      } finally {
        fixture.stdin?.destroy();
        watchdog.stdin?.destroy();
      }
    }
    for (const phase of providerSetup
      ? (["provider"] as const)
      : (["initial", "restart"] as const)) {
      const app = spawnPackagedApplication({
        executable: join(bundle, "Contents/MacOS/Octant"),
        env,
      });
      const pid = app.child.pid;
      if (pid === undefined) throw Error("Owned app did not start.");
      const watchdog = ownWatchdog(pid, phase);
      const systemEvents = (operation: string, value = "") =>
        runBoundedCommand(
          "/usr/bin/osascript",
          ["-e", ax, String(pid), operation, value],
          process.env,
          6000,
        );
      const sdk = (
        mode:
          | "diagnostic"
          | "read"
          | "click"
          | "reveal"
          | "dock-read"
          | "quit-hint"
          | "dock-click"
          | "bundle-census"
          | "bundle-cleanup"
          | "fill-name"
          | "fill-address"
          | "picker-metadata"
          | "picker-location-prompt"
          | "picker-fill-owned-location"
          | "picker-go-owned-location"
          | "picker-choose-owned-folder"
          | "picker-create-owned-project",
        value?: string,
        pinnedBirth?: string,
      ) =>
        runBoundedCommand(
          sdkExecutable,
          [
            String(pid),
            bundle,
            mode,
            ...(value === undefined ? [] : [value]),
            ...(pinnedBirth === undefined ? [] : [pinnedBirth]),
          ],
          process.env,
          6000,
        );
      let ownerBirth:
        | { readonly seconds: number; readonly microseconds: number; readonly executable: string }
        | undefined;
      const ownedBundleCleanup = async () => {
        retainOwnedFilesForWatchdog = true;
        const raw = await sdk("bundle-cleanup");
        await writeFile(join(artifacts, `${phase}-exact-bundle-cleanup.json`), raw);
        const decoded: unknown = JSON.parse(raw);
        if (
          typeof decoded !== "object" ||
          decoded === null ||
          !("cleanupObservation" in decoded) ||
          typeof decoded.cleanupObservation !== "object" ||
          decoded.cleanupObservation === null
        )
          throw Error("Exact task bundle cleanup did not return an ownership receipt.");
        const result = decoded.cleanupObservation;
        if (
          !("status" in result) ||
          result.status !== "absent" ||
          !("censusComplete" in result) ||
          result.censusComplete !== true ||
          !("remainingOwned" in result) ||
          !Array.isArray(result.remainingOwned) ||
          result.remainingOwned.length !== 0
        )
          throw Error(
            "Exact task bundle kernel census could not confirm all owned processes exited.",
          );
        if (!("initialOwned" in result) || !Array.isArray(result.initialOwned))
          throw Error("Exact task bundle cleanup did not describe its initial ownership.");
        watchdog.kill("SIGTERM");
        if (!(await exited(watchdog, 6000)) || watchdog.exitCode !== 0)
          throw Error("Owned exact-bundle cleanup watchdog did not join successfully.");
        retainOwnedFilesForWatchdog = false;
        if (result.initialOwned.length !== 0)
          throw Error(
            "Unexpected task bundle process existed outside normal joined cleanup; its cleanup receipt is retained.",
          );
      };
      let clickSequence = 0;
      let revealSequence = 0;
      let pickerAttempted = false;
      let pickerBoundaryEntered = false;
      const native = async (operation: string, value = ""): Promise<string> => {
        if (pickerBoundaryEntered)
          throw Error("Picker discovery permits no further named reads or input.");
        if (
          operation !== "snapshot" &&
          operation !== "count" &&
          operation !== "click" &&
          operation !== "reveal" &&
          operation !== "fill-name" &&
          operation !== "fill-address" &&
          operation !== "dock-click"
        )
          return systemEvents(operation, value);
        const fillsField = operation === "fill-name" || operation === "fill-address";
        if (operation === "click" || operation === "reveal" || fillsField)
          await systemEvents("focus");
        if (fillsField && ownerBirth === undefined)
          throw Error("No original process birth for fixture typing.");
        if (operation === "dock-click" && ownerBirth === undefined)
          throw Error("No pinned original kernel process birth is available for Dock input.");
        const raw = await sdk(
          operation === "dock-click"
            ? "dock-click"
            : operation === "click" || operation === "reveal" || fillsField
              ? operation
              : "read",
          operation === "dock-click" && ownerBirth !== undefined
            ? `${ownerBirth.seconds}:${ownerBirth.microseconds}`
            : operation === "click" || operation === "reveal" || fillsField
              ? value
              : undefined,
          fillsField && ownerBirth !== undefined
            ? `${ownerBirth.seconds}:${ownerBirth.microseconds}`
            : undefined,
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
        const identity = decoded.ownerKernelIdentity;
        if (
          !record(identity) ||
          identity.pid !== pid ||
          identity.underExactStagedBundle !== true ||
          typeof identity.birthSeconds !== "number" ||
          !Number.isSafeInteger(identity.birthSeconds) ||
          identity.birthSeconds <= 0 ||
          typeof identity.birthMicroseconds !== "number" ||
          !Number.isSafeInteger(identity.birthMicroseconds) ||
          identity.birthMicroseconds < 0 ||
          identity.birthMicroseconds >= 1_000_000 ||
          typeof identity.kernelCanonicalExecutable !== "string" ||
          !identity.kernelCanonicalExecutable.endsWith("/Contents/MacOS/Octant")
        )
          throw Error("Native SDK did not prove the owned kernel process identity.");
        if (ownerBirth === undefined)
          ownerBirth = {
            seconds: identity.birthSeconds,
            microseconds: identity.birthMicroseconds,
            executable: identity.kernelCanonicalExecutable,
          };
        else if (
          ownerBirth.seconds !== identity.birthSeconds ||
          ownerBirth.microseconds !== identity.birthMicroseconds ||
          ownerBirth.executable !== identity.kernelCanonicalExecutable
        )
          throw Error("Native SDK original process birth or executable changed.");
        if (operation === "count") return String(decoded.axWindowCount);
        if (
          decoded.treeTruncated !== false ||
          decoded.treeReadErrors !== 0 ||
          !Array.isArray(decoded.interactiveControls)
        )
          throw Error("Native SDK control tree is incomplete.");
        if (fillsField) {
          if (
            !record(decoded.action) ||
            decoded.action.status !== "text-dispatched" ||
            decoded.action.method !== "fixed-nonsecret-fixture-field" ||
            decoded.action.matches !== 1 ||
            decoded.action.exactNonsecureFieldFocused !== true ||
            decoded.action.textDispatched !== true
          )
            throw Error(
              "Native SDK refused the exact owned nonsecure fixture field. No typing is retried.",
            );
          return "text-dispatched";
        }
        if (operation === "dock-click") {
          if (
            !record(decoded.dockObservation) ||
            decoded.dockObservation.status !== "dispatched" ||
            decoded.dockObservation.interactionDispatched !== true
          )
            throw Error(
              "Fresh Dock-specific actionability guards refused input. No action is retried.",
            );
          return "dispatched";
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
            if (
              control.fieldLabel !== undefined &&
              (control.ownedEndpointDialog !== true ||
                !["Name", "Address"].includes(String(control.fieldLabel)))
            )
              throw Error("Unexpected fixture field label.");
            return `${control.role} | ${control.title || control.fieldLabel || ""} | ${control.description} | ${control.value ?? ""}`;
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
        settleMs = 0,
      ) => {
        const deadline = Date.now() + bound;
        let snapshot = "";
        let lastError = "";
        let matchingSnapshot: string | undefined;
        let matchingSince = 0;
        while (!controller.signal.aborted && Date.now() < deadline) {
          if (app.child.exitCode !== null || app.child.signalCode !== null)
            throw Error("Owned app exited during native inspection.");
          try {
            snapshot = await native("snapshot");
            lastError = "";
            if (predicate(snapshot)) {
              if (settleMs === 0) return snapshot;
              if (matchingSnapshot !== snapshot) {
                matchingSnapshot = snapshot;
                matchingSince = Date.now();
              } else if (Date.now() - matchingSince >= settleMs) return snapshot;
            } else matchingSnapshot = undefined;
          } catch (error) {
            matchingSnapshot = undefined;
            lastError = error instanceof Error ? error.message.slice(-1200) : "Native read failed.";
          }
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
        await wait(
          "loaded-preference",
          (s) => s.includes(preference) && s.includes("New account profile…"),
          12_000,
          500,
        );
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
        if (phase !== "restart") {
          await wait(
            "onboarding",
            (s) => s.includes("AXButton") && s.includes("Skip setup"),
            45_000,
          );
          await native("click", "Skip setup");
          await wait("skip", (s) => s.includes("AXButton") && !s.includes("Skip setup"));
        } else
          await wait("restarted-window", (s) => s.includes("AXButton |  | Settings |"), 45_000);
        if (phase === "provider") {
          if (provider === undefined) throw Error("No owned provider fixture.");
          await wait("app-settings-entry", (s) => s.includes("AXButton |  | Settings |"));
          await native("click", "Settings");
          await wait("settings-harness", (s) => s.includes("Octant Harness"));
          await native("reveal", "Octant Harness");
          await native("click", "Octant Harness");
          await wait("add-endpoint", (s) => s.includes("Add endpoint"), 12_000, 500);
          await native("reveal", "Add endpoint");
          await native("click", "Add endpoint");
          const kindLabel =
            "OpenAI-compatible Any service that speaks the OpenAI API: a gateway, a router, or a local server.";
          const kinds = await wait("endpoint-kinds", (s) => s.includes("OpenAI-compatible"));
          const kind = kinds
            .split("\n")
            .flatMap((row) => row.split(" | ").slice(1, 3))
            .find((label) => label === kindLabel || label === "OpenAI-compatible");
          if (kind === undefined) throw Error("Observed endpoint kind has no exact source label.");
          await native("reveal", kind);
          await native("click", kind);
          await wait(
            "endpoint-fixed-fields",
            (s) => s.includes("AXTextField | Name |") && s.includes("AXTextField | Address |"),
          );
          await native("fill-name", OWNED_BROWSER_FIXTURE_NAME);
          await native("fill-address", provider.baseUrl);
          await wait("endpoint-advanced", (s) => s.includes("Advanced"));
          await native("reveal", "Advanced");
          await native("click", "Advanced");
          const noKeyLabel =
            "It takes no key Only for a server on this computer, such as one at 127.0.0.1.";
          const advanced = await wait("endpoint-no-key", (s) => s.includes("It takes no key"));
          const noKey = advanced
            .split("\n")
            .flatMap((row) => row.split(" | ").slice(1, 3))
            .find((label) => label === noKeyLabel || label === "It takes no key");
          if (noKey === undefined) throw Error("Observed no-key choice has no exact source label.");
          await native("reveal", noKey);
          await native("click", noKey);
          await native("reveal", "Check and add");
          await native("click", "Check and add");
          await wait("endpoint-added", (s) => s.includes("AXButton | Continue |"));
          if (provider.evidence().models < 1)
            throw Error("Added endpoint did not reach the owned model fixture.");
          await native("click", "Continue");
          const verify = "Continue and verify tools (1 request)";
          await wait("endpoint-models", (s) => s.includes(verify));
          await native("reveal", verify);
          await native("click", verify);
          const probeDeadline = Date.now() + 12_000;
          while (
            !controller.signal.aborted &&
            provider.evidence().chatProbes !== 1 &&
            Date.now() < probeDeadline
          )
            await pause(100);
          if (
            provider.evidence().chatProbes !== 1 ||
            provider.evidence().responsesRefused !== 1 ||
            provider.evidence().rejected !== 0
          )
            throw Error("Normal Verify tools did not use the exact Responses404 to Chat probe.");
          const verified = await wait(
            "endpoint-verified-result",
            (s) => s.includes("AXButton | Continue |"),
            12_000,
            500,
          );
          await capture("verify-tools-result", verified);
          checks.push("normal-native-ui-endpoint-added-and-real-auto-fallback-tool-probe-served");
          // Closing after registration keeps the endpoint. Do not assign agent
          // roles or begin a task in this first, independently reviewed gate.
          await native("escape");
          await wait(
            "endpoint-dialog-closed",
            (s) => !s.includes("Check and add") && !s.includes("AXButton | Continue |"),
          );
          if (projectPickerDiscovery) {
            await wait("back-to-app", (s) => s.includes("Back to app"));
            await native("reveal", "Back to app");
            await native("click", "Back to app");
            await wait("work-mode-entry", (s) => s.includes(" | Work |"));
            await native("reveal", "Work");
            await native("click", "Work");
            await wait("folder-thread-kind", (s) => s.includes("AXCheckBox | In a folder |"));
            await native("reveal", "In a folder");
            await native("click", "In a folder");
            await wait(
              "folder-draft-ready",
              (s) => s.includes("Project: Choose a Project"),
              12_000,
              500,
            );
            // Work's compact sidebar deliberately has no Add folder button.
            // Its normal welcome screen offers the same Project root chooser.
            await native("reveal", "Home");
            await native("click", "Home");
            await wait("work-folder-welcome", (s) => s.includes("Choose a folder…"));
            await native("reveal", "Choose a folder…");
            await native("click", "Choose a folder…");
            await wait(
              "project-choose-folder",
              (s) => s.includes("Project name") && s.includes("Choose a folder"),
            );
            await native("reveal", "Choose a folder");
            if (ownerBirth === undefined)
              throw Error("No original process birth for picker discovery.");
            const birth = `${ownerBirth.seconds}:${ownerBirth.microseconds}`;
            const metadata = async (name: string) => {
              const raw = await sdk("picker-metadata", birth);
              await writeFile(join(artifacts, `${name}.json`), raw);
              const value: unknown = JSON.parse(raw);
              if (
                typeof value !== "object" ||
                value === null ||
                !("capturedPid" in value) ||
                value.capturedPid !== pid ||
                !("capturedIdentityMatched" in value) ||
                value.capturedIdentityMatched !== true ||
                !("nativeAxTrusted" in value) ||
                value.nativeAxTrusted !== true ||
                !("interactionDispatched" in value) ||
                value.interactionDispatched !== false ||
                !("labelsOrValuesRead" in value) ||
                value.labelsOrValuesRead !== false ||
                !("windowOwnership" in value) ||
                !Array.isArray(value.windowOwnership) ||
                !("roles" in value) ||
                !Array.isArray(value.roles) ||
                value.roles.length > 512 ||
                !("windowsError" in value) ||
                typeof value.windowsError !== "number" ||
                !("readErrors" in value) ||
                typeof value.readErrors !== "number" ||
                !Number.isSafeInteger(value.readErrors) ||
                value.readErrors < 0 ||
                !("truncated" in value) ||
                typeof value.truncated !== "boolean" ||
                !("windowOwnershipTruncated" in value) ||
                typeof value.windowOwnershipTruncated !== "boolean" ||
                !("foreignPidBoundaryObserved" in value) ||
                typeof value.foreignPidBoundaryObserved !== "boolean"
              )
                throw Error(
                  "Owned picker metadata did not preserve its read-only identity boundary.",
                );
              return value;
            };
            const before = await metadata("project-picker-before");
            if (
              before.foreignPidBoundaryObserved ||
              before.windowsError !== 0 ||
              before.readErrors !== 0 ||
              before.truncated ||
              before.windowOwnershipTruncated
            )
              throw Error("Incomplete or unknown process metadata before opening the picker.");
            pickerAttempted = true;
            try {
              await native("click", "Choose a folder");
            } finally {
              // Even an uncertain dispatch may have opened a filesystem picker.
              // Never run the ordinary label-reading controller beyond here.
              pickerBoundaryEntered = true;
            }
            const deadline = Date.now() + 8_000;
            let observation = before;
            let sample = 0;
            do {
              await pause(250);
              observation = await metadata(`project-picker-after-${++sample}`);
              const nativeDialog = observation.roles.some(
                (node: unknown) =>
                  typeof node === "object" &&
                  node !== null &&
                  (("role" in node && ["AXSheet", "AXDialog"].includes(String(node.role))) ||
                    ("subrole" in node &&
                      ["AXDialog", "AXSystemDialog"].includes(String(node.subrole)))),
              );
              if (
                observation.foreignPidBoundaryObserved ||
                nativeDialog ||
                JSON.stringify(observation.windowOwnership) !==
                  JSON.stringify(before.windowOwnership)
              )
                break;
            } while (!controller.signal.aborted && Date.now() < deadline && sample < 4);
            await writeFile(
              join(artifacts, "project-picker-discovery.json"),
              JSON.stringify(
                {
                  metadataSamples: sample,
                  foreignPidBoundaryObserved: observation.foreignPidBoundaryObserved,
                  readErrors: observation.readErrors,
                  truncated: observation.truncated,
                  windowsError: observation.windowsError,
                  windowOwnershipTruncated: observation.windowOwnershipTruncated,
                  namedReadsAfterPickerAttempt: false,
                  subsequentInteractionDispatched: false,
                  checkpoint: "before-dedicated-location-prompt-command",
                  emptyOwnedFolderCreated: true,
                  projectBinding: "not-attempted",
                  pickerSelection: "not-attempted",
                  result: "metadata retained for independent source and observed-control review",
                },
                null,
                2,
              ),
            );
            checks.push(
              "normal-work-folder-picker-requested-and-read-only-metadata-retained-without-selection",
            );
            // This dedicated fixed command does not reopen native(), whose
            // post-picker privacy latch remains set even after uncertainty.
            const promptRaw = await sdk("picker-location-prompt", birth);
            await writeFile(join(artifacts, "project-picker-location-prompt.json"), promptRaw);
            const prompt: unknown = JSON.parse(promptRaw);
            if (
              typeof prompt !== "object" ||
              prompt === null ||
              !("capturedPid" in prompt) ||
              prompt.capturedPid !== pid ||
              !("capturedIdentityMatched" in prompt) ||
              prompt.capturedIdentityMatched !== true ||
              !("fieldValuesRead" in prompt) ||
              prompt.fieldValuesRead !== false ||
              !("directoryLabelsRead" in prompt) ||
              prompt.directoryLabelsRead !== false ||
              !("locationPrompt" in prompt) ||
              typeof prompt.locationPrompt !== "object" ||
              prompt.locationPrompt === null ||
              !("status" in prompt.locationPrompt) ||
              prompt.locationPrompt.status !== "observed" ||
              !("observedNestedLocationSequence" in prompt.locationPrompt) ||
              prompt.locationPrompt.observedNestedLocationSequence !== true ||
              !("identityAndAssociationRechecked" in prompt.locationPrompt) ||
              prompt.locationPrompt.identityAndAssociationRechecked !== true ||
              !("typingDispatched" in prompt.locationPrompt) ||
              prompt.locationPrompt.typingDispatched !== false ||
              !("confirmationDispatched" in prompt.locationPrompt) ||
              prompt.locationPrompt.confirmationDispatched !== false ||
              !("selectionDispatched" in prompt.locationPrompt) ||
              prompt.locationPrompt.selectionDispatched !== false
            )
              throw Error(
                "Fixed native Go-to-Folder prompt was refused or remained unconfirmed; no typing or retry.",
              );
            checks.push(
              "one-native-go-to-folder-chord-and-observed-nested-location-sequence-without-title-assumption",
            );
            if (
              !("associatedServiceNode" in prompt) ||
              typeof prompt.associatedServiceNode !== "object" ||
              prompt.associatedServiceNode === null
            )
              throw Error("No exact signed service identity for owned-folder stages.");
            const service = prompt.associatedServiceNode;
            if (
              !("pid" in service) ||
              typeof service.pid !== "number" ||
              !Number.isSafeInteger(service.pid) ||
              service.pid <= 1 ||
              service.pid > 2147483647 ||
              !("birthSeconds" in service) ||
              typeof service.birthSeconds !== "number" ||
              !Number.isSafeInteger(service.birthSeconds) ||
              service.birthSeconds <= 0 ||
              !("birthMicroseconds" in service) ||
              typeof service.birthMicroseconds !== "number" ||
              !Number.isSafeInteger(service.birthMicroseconds) ||
              service.birthMicroseconds < 0 ||
              service.birthMicroseconds >= 1000000
            )
              throw Error("Signed picker service identity is incomplete.");
            const canonicalRoot = await realpath(root);
            const directoryPaths = [
              canonicalRoot,
              join(canonicalRoot, "home"),
              join(canonicalRoot, "home", "owned-browser-project"),
            ];
            const directoryPins = await Promise.all(
              directoryPaths.map((path) => lstat(path, { bigint: true })),
            );
            const uid = process.getuid?.();
            if (uid === undefined) throw Error("No owned fixture UID.");
            const assertOwnedDirectories = async () => {
              for (const [index, path] of directoryPaths.entries()) {
                const pinned = directoryPins[index];
                const current = await lstat(path, { bigint: true });
                if (
                  pinned === undefined ||
                  !current.isDirectory() ||
                  current.isSymbolicLink() ||
                  current.uid !== BigInt(uid) ||
                  current.dev !== pinned.dev ||
                  current.ino !== pinned.ino ||
                  (await realpath(path)) !== path ||
                  (index === 0 && (current.mode & 0o077n) !== 0n)
                )
                  throw Error("Owned fixture directory identity changed; no action retry.");
              }
            };
            await assertOwnedDirectories();
            const pins = [
              BigInt(ownerBirth.seconds),
              BigInt(ownerBirth.microseconds),
              BigInt(service.pid),
              BigInt(service.birthSeconds),
              BigInt(service.birthMicroseconds),
              ...directoryPins.flatMap((entry) => [entry.dev, entry.ino]),
            ]
              .map((entry) => entry.toString(10))
              .join(":");
            const fixedStage = async (
              mode:
                | "picker-fill-owned-location"
                | "picker-go-owned-location"
                | "picker-choose-owned-folder"
                | "picker-create-owned-project",
            ) => {
              if (controller.signal.aborted)
                throw Error("Owned-folder action cancelled before validation; no dispatch.");
              await assertOwnedDirectories();
              if (controller.signal.aborted)
                throw Error("Owned-folder action cancelled during validation; no dispatch.");
              const raw = await sdk(mode, pins);
              await writeFile(join(artifacts, `${mode}.json`), raw);
              if (controller.signal.aborted)
                throw Error(
                  "Owned-folder action cancelled; actual receipt retained and no next effect.",
                );
              const parsed: unknown = JSON.parse(raw);
              if (
                typeof parsed !== "object" ||
                parsed === null ||
                !("capturedIdentityMatched" in parsed) ||
                parsed.capturedIdentityMatched !== true ||
                !("capturedPid" in parsed) ||
                parsed.capturedPid !== pid ||
                !("directoryLabelsRead" in parsed) ||
                parsed.directoryLabelsRead !== false
              )
                throw Error("Owned-folder command lost its captured process; no replay.");
              let result: unknown = parsed;
              if (mode !== "picker-create-owned-project") {
                if (!("fixedFolder" in parsed))
                  throw Error("Missing fixed-folder command receipt.");
                result = parsed.fixedFolder;
              }
              const expected =
                mode === "picker-fill-owned-location" || mode === "picker-go-owned-location"
                  ? "completed"
                  : "dispatched";
              if (
                typeof result !== "object" ||
                result === null ||
                !("status" in result) ||
                result.status !== expected ||
                !("fixtureIdentityMatched" in result) ||
                result.fixtureIdentityMatched !== true ||
                !("rawValueCaptured" in result) ||
                result.rawValueCaptured !== false
              )
                throw Error("Owned-folder command refused or remained uncertain; no replay.");
              if (
                mode !== "picker-create-owned-project" &&
                (!("codeSigningVerified" in result) || result.codeSigningVerified !== true)
              )
                throw Error("Fixed picker command did not retain signature verification.");
              if (
                (mode === "picker-fill-owned-location" || mode === "picker-go-owned-location") &&
                (!("fixedOwnedFieldValueCompared" in result) ||
                  result.fixedOwnedFieldValueCompared !== true ||
                  !("fixedOwnedFieldValueMatched" in result) ||
                  result.fixedOwnedFieldValueMatched !== true)
              )
                throw Error("Exact derived owned path was not proven in the location field.");
            };
            await fixedStage("picker-fill-owned-location");
            await fixedStage("picker-go-owned-location");
            await fixedStage("picker-choose-owned-folder");
            await fixedStage("picker-create-owned-project");
            const expectedRoot = directoryPaths[2];
            if (expectedRoot === undefined) throw Error("No expected owned Project root.");
            const bindingDeadline = Date.now() + 3000;
            while (true) {
              if (controller.signal.aborted) throw Error("Owned Project binding check cancelled.");
              await assertOwnedDirectories();
              if (controller.signal.aborted)
                throw Error("Owned Project binding check cancelled after validation.");
              const database = openReadOnlySqlite(join(canonicalRoot, "data", "octant.sqlite3"));
              let rows: ReadonlyArray<unknown>;
              try {
                rows =
                  database.all(`SELECT json_extract(payload_json, '$.project.type') AS project_type,
                  json_extract(payload_json, '$.project.name') AS project_name,
                  json_extract(payload_json, '$.project.binding.canonicalRoot') AS root,
                  global_sequence FROM event_journal WHERE event_name = 'project.created@1'
                  AND aggregate_type = 'project' AND json_extract(payload_json, '$.project.type') = 'work'
                  ORDER BY global_sequence DESC LIMIT 2`);
              } finally {
                database.close();
              }
              if (controller.signal.aborted)
                throw Error("Owned Project binding check cancelled after read.");
              const row = rows[0];
              if (
                rows.length === 1 &&
                typeof row === "object" &&
                row !== null &&
                "project_type" in row &&
                row.project_type === "work" &&
                "project_name" in row &&
                row.project_name === "owned-browser-project" &&
                "root" in row &&
                row.root === expectedRoot &&
                "global_sequence" in row &&
                typeof row.global_sequence === "number" &&
                Number.isSafeInteger(row.global_sequence) &&
                row.global_sequence > 0
              ) {
                ownedProjectBindingVerified = true;
                await writeFile(
                  join(artifacts, "owned-project-binding-read-only.json"),
                  JSON.stringify({
                    projectType: "work",
                    exactOwnedRootMatched: true,
                    expectedNameMatched: true,
                    eventCount: 1,
                    globalSequence: row.global_sequence,
                    journalReadOnly: true,
                    rawValueCaptured: false,
                  }),
                );
                checks.push(
                  "ordinary-ui-work-project-created-with-exact-owned-root-journal-binding",
                );
                break;
              }
              if (rows.length !== 0 || Date.now() >= bindingDeadline)
                throw Error("Project binding was not the exact owned root; no effect replay.");
              await pause(100);
            }
            continue;
          }
        } else {
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
            while (Date.now() < deadline && (await native("count")).trim() !== "0")
              await pause(100);
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
            const censusRaw = await sdk("bundle-census");
            await writeFile(join(artifacts, "initial-before-dock-kernel-census.json"), censusRaw);
            const census: unknown = JSON.parse(censusRaw);
            if (
              typeof census !== "object" ||
              census === null ||
              !("cleanupObservation" in census) ||
              typeof census.cleanupObservation !== "object" ||
              census.cleanupObservation === null ||
              !("censusComplete" in census.cleanupObservation) ||
              census.cleanupObservation.censusComplete !== true ||
              !("initialOwned" in census.cleanupObservation) ||
              !Array.isArray(census.cleanupObservation.initialOwned) ||
              census.cleanupObservation.initialOwned.length === 0 ||
              census.cleanupObservation.initialOwned.some(
                (item: unknown) =>
                  typeof item !== "object" ||
                  item === null ||
                  !("groupPid" in item) ||
                  item.groupPid !== pid,
              )
            )
              throw Error(
                "Pre-Dock exact bundle census found unknown or outside-group task ownership.",
              );
            await native("dock-click");
            await wait("dock-reopened", (s) => s.includes("AXButton |  | Settings |"));
            snapshot = await settings();
            await recordPersisted("initial-reopened", true);
            await capture("reopened", snapshot);
            checks.push("same-original-kernel-process-window-reopened-and-opt-in-persisted");
          } else {
            await native("click", preference);
            await recordPersisted("restart-after-opt-out", false);
            snapshot = await native("snapshot");
            await capture("opt-out", snapshot);
            checks.push("single-ui-opt-out-persisted-in-owned-journal");
          }
        }
        // The normal visible-window shortcut asks for a second press. With no
        // window, the first press quits directly because no hint can be shown.
        {
          const confirmationDeadline = Date.now() + 1100;
          await native("key", "q");
          let observed = false;
          while (Date.now() < confirmationDeadline - 300 && !controller.signal.aborted) {
            const raw = await sdk("quit-hint");
            await writeFile(join(artifacts, `${phase}-quit-confirmation.json`), raw);
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
          checks.push(`${phase}-normal-visible-window-quit-hint-observed-before-confirmation`);
        }
        if (!(await exited(app.child, 8000)))
          throw Error("Explicit native Quit did not exit the host.");
        checks.push(`${phase}-explicit-quit-exited`);
      } finally {
        try {
          await writeFile(
            join(artifacts, `${phase}-app-output.txt`),
            pickerAttempted
              ? "App output after the picker request is intentionally not retained."
              : redactHostRuntimeText(app.outputTail()),
          );
        } finally {
          try {
            await cleanupPackagedProcess({
              child: app.child,
              requestQuit: () =>
                projectPickerDiscovery
                  ? Promise.resolve()
                  : runBoundedCommand(
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
                if (groupProcesses(pid).length !== 0)
                  throw Error("Owned app process-group cleanup incomplete.");
              },
              gracefulTimeoutMs: 3000,
              forceTimeoutMs: 2000,
            });
          } finally {
            try {
              await ownedBundleCleanup();
            } finally {
              watchdog.stdin?.destroy();
            }
          }
        }
      }
    }
    if (controller.signal.aborted) throw Error("Owned native lifecycle interrupted.");
    await provider?.close();
    if (provider !== undefined) checks.push("owned-loopback-provider-listener-and-sockets-joined");
    await writeFile(
      join(
        artifacts,
        projectPickerDiscovery
          ? "project-picker-gate-evidence.json"
          : providerSetup
            ? "provider-setup-evidence.json"
            : "lifecycle-evidence.json",
      ),
      JSON.stringify(
        providerSetup
          ? {
              checks,
              nativeUi: true,
              endpointVerification: "pending independent visual review",
              fixture: provider?.evidence(),
              protocol: "Automatic: Responses404 to Chat Completions",
              visualStateImages,
              cleanup: projectPickerDiscovery
                ? "app/provider joined; fixture directory cleanup recorded separately"
                : "verified",
              reusedWindowLifecycleHead: "4139726ac11dce5affa3c6744be732fa17509e7b",
              activeExecutionLease: "not-run",
              profileCookieContinuity: "not-run",
              personalAccount: false,
              ...(projectPickerDiscovery
                ? {
                    projectBinding: ownedProjectBindingVerified
                      ? "verified-exact-owned-root"
                      : "unconfirmed",
                    pickerSelection: "one normal chooser click; exact binding verified separately",
                    subsequentInteractionDispatched: true,
                    subsequentInteraction:
                      "fixed owned location, normal Go, chooser and Create Project only",
                    fixedOwnedFieldValueCompared: true,
                    rawValueCaptured: false,
                  }
                : {}),
            }
          : {
              checks,
              nativeUi: true,
              nativeInputMethod: "single native click at fresh owned AX bounds",
              stateVerificationMethod:
                "rendered screenshots with read-only preference journal corroboration",
              nativeAxCheckedState: "unavailable-empty-CFString",
              stateChecks: "pending independent visual review",
              windowLifecycleCriteriaComplete: true,
              lastWindowReopen: {
                status: "same-original-kernel-process-window-reopened",
                method: "single guarded native Dock click",
                previousAppleEventRefusal: -1744,
                appleEventRetried: false,
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
  } finally {
    clearTimeout(lifetime);
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
    try {
      if (provider !== undefined) {
        let cleanup = "unconfirmed";
        try {
          await provider.close();
          cleanup = "joined";
        } finally {
          await writeFile(
            join(artifacts, "provider-fixture-cleanup.json"),
            JSON.stringify({ ...provider.evidence(), cleanup }),
          );
        }
      }
    } finally {
      if (!retainOwnedFilesForWatchdog) {
        await rm(root, { recursive: true, force: true });
        if (bundle.startsWith(join(tmpdir(), "octant-packaged-app.")))
          await rm(dirname(bundle), { recursive: true, force: true });
        if (projectPickerDiscovery) {
          await recordOwnedPickerDirectoryCleanup(root, artifacts);
        }
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Native Browser owner smoke failed.");
  process.exitCode = 1;
});
