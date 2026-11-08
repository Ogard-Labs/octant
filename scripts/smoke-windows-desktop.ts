import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import {
  loadWindowsHostProfileNative,
  attachWindowsHostRuntimeOwner,
  KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT,
} from "@octant/host-runtime";
import {
  resolveWindowsDesktopHost,
  attachWindowsDesktopHost,
} from "../apps/desktop/src/windowsDesktopHost";

const [packageArgument, phase, outputArgument, nightlyArgument] = process.argv.slice(2);
if (
  process.platform !== "win32" ||
  !packageArgument ||
  !outputArgument ||
  (phase !== "owned" && phase !== "attached" && phase !== "nightly" && phase !== "nightly-cold") ||
  ((phase === "nightly" || phase === "nightly-cold") && !nightlyArgument)
)
  throw Error("Use the isolated native Windows desktop fixture.");
const directory = resolve(packageArgument),
  output = resolve(outputArgument);
const executable = join(directory, "Octant.exe");
const nightlyExecutable =
  nightlyArgument === undefined ? undefined : join(resolve(nightlyArgument), "Octant Nightly.exe");
const native = loadWindowsHostProfileNative(
  join(directory, "resources/native/octant-windows-host-owner.node"),
);
if (native === undefined) throw Error("The packaged native profile binding is unavailable.");
const host = resolveWindowsDesktopHost({ native, profile: "octant", env: {} });
await mkdir(output, { recursive: true });
await writeFile(join(output, "scope.json"), JSON.stringify({ scope: host.paths.profileId }));
const children = new Set<ChildProcess>();
const births = new WeakMap<ChildProcess, string>();
const executables = new WeakMap<ChildProcess, string>();
const diagnostics = new Map<ChildProcess, { readonly role: string; readonly read: () => string }>();
const checks: string[] = [];
const run = promisify(execFile);
const begin = Date.now();
function check(value: boolean, name: string) {
  if (!value) throw Error(`Windows desktop proof failed: ${name}`);
  checks.push(name);
}
async function until(name: string, predicate: () => Promise<boolean>, limit = 12000) {
  const end = Math.min(begin + 34000, Date.now() + limit);
  do {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < end);
  throw Error(`Windows desktop proof timed out: ${name}`);
}
function launch(server = false, seed?: string, target = executable) {
  const env = { ...process.env };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "OCTANT_DATA_DIR",
    "OCTANT_LOGS_DIR",
    "OCTANT_CREDENTIAL_BROKER_URL",
    "OCTANT_CREDENTIAL_BROKER_TOKEN",
    "OCTANT_DESKTOP_BRIDGE_SECRET",
    "OCTANT_DESKTOP_PARENT_WATCH",
    KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT,
  ])
    delete env[key];
  if (server)
    Object.assign(env, {
      ELECTRON_RUN_AS_NODE: "1",
      OCTANT_PACKAGED_RUNTIME: "1",
      OCTANT_HOST_SERVICE_MODE: "foreground",
      OCTANT_DESKTOP_BRIDGE_SECRET: seed,
      [KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT]: "octant",
    });
  const child = spawn(
    target,
    server ? [join(directory, "resources/app/apps/server/dist/main.mjs")] : [],
    { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: server },
  );
  children.add(child);
  executables.set(child, target);
  let diagnostic = "";
  diagnostics.set(child, { role: server ? "server" : "desktop", read: () => diagnostic });
  child.stderr?.on("data", (bytes: Buffer) => {
    diagnostic = (diagnostic + bytes.toString()).slice(-8192);
  });
  child.once("error", () => {
    diagnostic = "The exact owned process did not start.";
  });
  child.once("close", () => {
    children.delete(child);
    void writeFile(
      join(output, `${phase}-${server ? "server" : "desktop"}-${child.pid}.txt`),
      diagnostic.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]"),
    );
  });
  return child;
}
async function window(child: ChildProcess, close = false, requireRendered = false) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  if (close && !births.has(child))
    throw Error("An unobserved process cannot receive native close.");
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve(import.meta.dirname, "windows-desktop-window.ps1"),
      "-OwnedPid",
      String(child.pid),
      "-Executable",
      executables.get(child) ?? executable,
      "-ExpectedBirth",
      births.get(child) ?? "",
      "-CapturePath",
      join(output, `${phase}-window.png`),
      "-Mode",
      close ? "close" : "observe",
    ],
    { timeout: 8000, maxBuffer: 8192 },
  );
  const value: unknown = JSON.parse(result.stdout);
  if (
    typeof value !== "object" ||
    value === null ||
    !("birth" in value) ||
    typeof value.birth !== "string" ||
    !/^\d{16,20}$/.test(value.birth)
  )
    throw Error("The native process birth was not observed.");
  births.set(child, value.birth);
  return (
    "visibleOwnedWindow" in value &&
    value.visibleOwnedWindow === true &&
    (!requireRendered || ("renderedWelcome" in value && value.renderedWelcome === true))
  );
}
async function joined(child: ChildProcess) {
  await until(
    "owned process exit",
    async () => child.exitCode !== null || child.signalCode !== null,
    8000,
  );
  check(child.exitCode === 0, "the exact owned root exited normally");
}
async function ready() {
  await until(
    "native storage-ready projection",
    async () => (await host.startup.readHostInfo()) !== undefined,
    18000,
  );
  const attachment = await attachWindowsDesktopHost(host);
  if (attachment === undefined) throw Error("The actual native owner was absent after readiness.");
  return attachment;
}
async function launcherRecord() {
  const details = (await host.startup.logs.read({ limit: 20 })).entries
    .filter((entry) => entry.event === "desktop.launcher.record")
    .at(-1)?.details;
  const receipt = {
    status: details?.status === "recorded" ? "recorded" : "refused",
    ...(typeof details?.reason === "string" && /^[a-z-]{1,64}$/.test(details.reason)
      ? { reason: details.reason }
      : {}),
    ...(typeof details?.elapsedMs === "number" &&
    Number.isSafeInteger(details.elapsedMs) &&
    details.elapsedMs >= 0
      ? { elapsedMs: details.elapsedMs }
      : {}),
    ...(typeof details?.scannedEntries === "number" &&
    Number.isSafeInteger(details.scannedEntries) &&
    details.scannedEntries >= 0
      ? { scannedEntries: details.scannedEntries }
      : {}),
  };
  await writeFile(join(output, `${phase}-launcher.json`), JSON.stringify(receipt));
  console.log(JSON.stringify({ launcherRecord: receipt }));
  check(
    receipt.status === "recorded",
    "the actual desktop owner recorded its validated native launcher",
  );
}
async function coldHostIdentity(nightly: ChildProcess) {
  const found = await attachWindowsHostRuntimeOwner({
    native: host.native,
    scope: host.paths.profileId,
    hostId: host.paths.profileId,
    wireVersion: "1",
  });
  const parentBirth = births.get(nightly);
  if (
    found.status !== "attached" ||
    !/^win32:[0-9a-f]{16}$/.test(found.attachment.owner.processStart) ||
    !nightly.pid ||
    !parentBirth ||
    !nightlyExecutable
  )
    throw Error("The cold native owner could not be observed.");
  const owner = found.attachment.owner;
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve(import.meta.dirname, "windows-desktop-window.ps1"),
      "-Mode",
      "host-only",
      "-OwnedPid",
      String(owner.pid),
      "-Executable",
      executable,
      "-ExpectedBirth",
      BigInt(`0x${owner.processStart.slice(6)}`).toString(),
      "-ParentPid",
      String(nightly.pid),
      "-ParentExecutable",
      nightlyExecutable,
      "-ParentBirth",
      parentBirth,
    ],
    { timeout: 8000, maxBuffer: 8192 },
  );
  const value: unknown = JSON.parse(result.stdout);
  if (
    typeof value !== "object" ||
    value === null ||
    !("hostOnly" in value) ||
    value.hostOnly !== true ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !("birth" in value) ||
    typeof value.birth !== "string" ||
    !/^\d{16,20}$/.test(value.birth)
  )
    throw Error("The exact cold host process was not observed.");
  return { pid: value.pid, birth: value.birth };
}
async function coldHostExited(owner: { readonly pid: number; readonly birth: string }) {
  const result = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve(import.meta.dirname, "windows-desktop-window.ps1"),
      "-Mode",
      "exited",
      "-OwnedPid",
      String(owner.pid),
      "-Executable",
      executable,
      "-ExpectedBirth",
      owner.birth,
    ],
    { timeout: 8000, maxBuffer: 8192 },
  );
  const value: unknown = JSON.parse(result.stdout);
  return (
    typeof value === "object" &&
    value !== null &&
    "originalExited" in value &&
    value.originalExited === true
  );
}
async function stopped(url: string) {
  await until(
    "native projections cleared",
    async () =>
      (await host.startup.readHostInfo()) === undefined &&
      (await host.startup.readBridgeSecret()) === undefined,
    4000,
  );
  const found = await attachWindowsHostRuntimeOwner({
    native: host.native,
    scope: host.paths.profileId,
    hostId: host.paths.profileId,
    wireVersion: "1",
  });
  check(found.status === "missing", "native discovery confirms the owner stopped");
  const listening = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(500) })
    .then(() => true)
    .catch(() => false);
  check(!listening, "the owned server health listener is closed");
}
try {
  if (phase === "owned") {
    const app = launch();
    const first = await ready();
    await until("normal rendered welcome window", () => window(app, false, true));
    check(true, "the normal package opened its owned native window with visible welcome content");
    const receipt = await host.startup.readHostInfo();
    check(
      receipt?.hostId === host.paths.profileId && receipt.serviceMode === "desktop",
      "the desktop child uses the actual native profile and desktop role",
    );
    const duplicate = launch();
    await joined(duplicate);
    check(
      (await host.startup.readHostInfo())?.instanceId === first.probe.instanceId,
      "a second launch retains one actual native server generation",
    );
    check(await window(app), "the settled owned desktop window was freshly captured");
    check(
      await window(app, true),
      "normal owned window close was posted without focus or input injection",
    );
    await joined(app);
    await stopped(first.probe.url);
  } else if (phase === "attached") {
    const seed = randomBytes(32).toString("base64url");
    const server = launch(true, seed);
    const first = await ready();
    check(first.bridgeSecret === seed, "the actual foreground child publishes its own launch seed");
    const app = launch();
    await until("attached rendered welcome window", () => window(app, false, true));
    const attached = await attachWindowsDesktopHost(host);
    check(
      attached?.probe.instanceId === first.probe.instanceId && attached.bridgeSecret === seed,
      "desktop attachment preserves the native foreground owner and projection generation",
    );
    check(await window(app, true), "the attached desktop closes through its own native window");
    await joined(app);
    check(
      server.exitCode === null &&
        (await attachWindowsDesktopHost(host))?.probe.instanceId === first.probe.instanceId,
      "closing an attached desktop leaves its independently managed host running",
    );
    const owner = await attachWindowsHostRuntimeOwner({
      native,
      scope: host.paths.profileId,
      hostId: host.paths.profileId,
      wireVersion: "1",
    });
    if (owner.status !== "attached") throw Error("The actual foreground owner is unavailable.");
    check(
      await owner.attachment.requestStop(),
      "authenticated native control accepts an explicit owner stop",
    );
    await joined(server);
    await stopped(first.probe.url);
  } else if (phase === "nightly") {
    if (nightlyExecutable === undefined) throw Error("The normal Nightly package is required.");
    const stable = launch();
    const first = await ready();
    await until("Stable rendered welcome window", () => window(stable, false, true));
    await launcherRecord();
    const nightly = launch(false, undefined, nightlyExecutable);
    await until("Nightly rendered welcome window", () => window(nightly, false, true));
    check(
      true,
      "the normal Nightly package rendered welcome content through its native window lease",
    );
    check(
      (await attachWindowsDesktopHost(host))?.probe.instanceId === first.probe.instanceId,
      "Nightly shares Stable's exact native host generation",
    );
    check(await window(nightly, true), "the actual Nightly native window accepted close");
    await joined(nightly);
    check(
      (await attachWindowsDesktopHost(host))?.probe.instanceId === first.probe.instanceId,
      "closing Nightly preserves Stable's running native host",
    );
    check(await window(stable, true), "Stable closes after its Nightly client exits");
    await joined(stable);
    await stopped(first.probe.url);
  } else {
    if (nightlyExecutable === undefined) throw Error("The normal Nightly package is required.");
    const absent = await attachWindowsHostRuntimeOwner({
      native,
      scope: host.paths.profileId,
      hostId: host.paths.profileId,
      wireVersion: "1",
    });
    check(absent.status === "missing", "the cold launch starts without a native host owner");
    const nightly = launch(false, undefined, nightlyExecutable);
    const first = await ready();
    await until("cold Nightly rendered welcome window", () => window(nightly, false, true));
    const cold = await coldHostIdentity(nightly);
    check(true, "Nightly launched the exact Stable host without an ordinary Stable window");
    await launcherRecord();
    check(await window(nightly, true), "the cold-started Nightly window closes normally");
    await joined(nightly);
    await stopped(first.probe.url);
    await until("the exact cold-launched Stable process exited", () => coldHostExited(cold), 8000);
    check(true, "the cold-launched Stable process exited before owned job cleanup");
  }
  const receipt = {
    phase,
    checks,
    normalPackagedDesktop: true,
    nativeMetadataPreparedByFixture: true,
    personalAccountsUsed: false,
    workCodeEnabled: false,
  };
  await writeFile(join(output, `${phase}.json`), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} catch (error) {
  // Startup failures can leave a modal native error window before the server
  // publishes discovery. Observe it through the same exact PID/birth guard.
  for (const child of children) {
    if (diagnostics.get(child)?.role !== "desktop") continue;
    try {
      await window(child);
    } catch {
      await writeFile(
        join(output, `${phase}-window-refused.txt`),
        "The exact owned failure window could not be captured.",
      );
    }
  }
  throw error;
} finally {
  // The existing suspended owned-job launcher joins every descendant after
  // this controller exits, including cancellation or an unexpected failure.
  for (const [child, diagnostic] of diagnostics) {
    await writeFile(
      join(output, `${phase}-${diagnostic.role}-${child.pid}.txt`),
      diagnostic.read().replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]"),
    );
  }
  for (const child of children) child.kill();
}
