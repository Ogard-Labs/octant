// Unsigned packaged Nightly smoke (local; Apple Silicon macOS).
//
// Packages Octant Nightly the way the preview workflow names a build, with a
// dated preview version and no signing identity, then checks the bundle it
// produced, outside the checkout and under a throwaway home folder:
//
//  1. the bundle is Octant Nightly at that version, and it is not signed with
//     a Developer ID;
//  2. an ordinary launch refuses as a development build: its message names
//     the development build and the signed release it needs (read from the
//     alert through System Events; reported as unverified when this terminal
//     has no Accessibility access);
//  3. with separate test data chosen, the packaged bundle starts its own test
//     host on the throwaway home's test-data folder and an unused port, and
//     stops with the app.
//
// Every process it starts is stopped and verified gone, the throwaway home is
// removed, and the packaged output it created under `out/` is deleted. Set
// OCTANT_NIGHTLY_PACKAGED_SMOKE_REUSE=1 to check an existing
// `out/Octant Nightly.app` instead of packaging (it is then left in place),
// OCTANT_NIGHTLY_PACKAGED_SMOKE_KEEP=1 to keep what it packaged, and
// OCTANT_NIGHTLY_PACKAGED_SMOKE_HOLD_ALERT_MS to hold the refusal alert open
// for another tool to read when this terminal has no Accessibility access.
//
//   bun scripts/smoke-packaged-nightly-unsigned.ts
//
// Exits 0 when no check fails, 1 when one does, and 2 off Apple Silicon macOS.

import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { desktopIdentity } from "@octant/host-runtime";
import { spawnPackagedApplication, stagePackagedAppBundle } from "./packaged-smoke-process";
import { DESKTOP_PACKAGE_IDENTITY } from "./package-desktop";
import { SIGNING_ENVIRONMENT_VARIABLES } from "./sign-desktop";

const root = resolve(import.meta.dir, "..");
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const identity = desktopIdentity("nightly");

interface Check {
  readonly check: string;
  readonly status: "pass" | "fail" | "unverified";
  readonly detail?: string;
}

const checks: Array<Check> = [];
const started = new Map<number, string>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (address === null || typeof address === "string") throw new Error("No free port.");
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  running.delete(child);
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  // The app was started detached, in its own process group, with its helpers.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forced = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 15_000);
  await exited;
  clearTimeout(forced);
}

/** The process group's members, so a helper that outlives the app is caught. */
function groupMembers(pgid: number): ReadonlyArray<number> {
  const listed = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8", timeout: 5_000 });
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, group]) => group === pgid)
    .map(([pid]) => pid ?? 0)
    .filter((pid) => pid > 0);
}

function previewVersion(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${DESKTOP_PACKAGE_IDENTITY.version}-preview.${date}.1`;
}

function plistValue(bundle: string, key: string): string {
  return execFileSync("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    join(bundle, "Contents/Info.plist"),
  ])
    .toString()
    .trim();
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error(JSON.stringify({ status: "skipped", reason: "needs Apple Silicon macOS" }));
  process.exit(2);
}

const reuse = process.env.OCTANT_NIGHTLY_PACKAGED_SMOKE_REUSE === "1";
const keep = reuse || process.env.OCTANT_NIGHTLY_PACKAGED_SMOKE_KEEP === "1";
const outDirectory = join(root, "out");
const before = new Set(existsSync(outDirectory) ? readdirSync(outDirectory) : []);
const version = previewVersion();
const sourceBundle = join(outDirectory, `${identity.productName}.app`);
// The person's own Nightly window storage, which this smoke must never create.
const realStorage = join(homedir(), "Library", "Application Support", identity.windowStorageName);
const realStorageExisted = existsSync(realStorage);
const home = realpathSync(await mkdtemp(join(tmpdir(), "octant-nightly-packaged-home-")));
await chmod(home, 0o700);
let exitCode = 0;
let finishing: Promise<void> | undefined;
let stagedBundle: string | undefined;
const running = new Set<ChildProcess>();
// An interrupted run stops the app it launched and removes what it created.
// The packaging step itself runs synchronously and sees the signal first.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    checks.push({ check: "smoke", status: "fail", detail: `interrupted by ${signal}` });
    void Promise.allSettled([...running].map((child) => stop(child)))
      .then(() => finish())
      .then(() => process.exit(1));
  });
try {
  if (!reuse) {
    if (before.has(`${identity.productName}.app`))
      throw new Error(`${sourceBundle} already exists; move it aside or set the reuse switch.`);
    // No signing identity and no release declaration: a local unsigned build.
    const unsigned = { ...process.env };
    for (const name of [...SIGNING_ENVIRONMENT_VARIABLES, "OCTANT_RELEASE_BUILD"])
      delete unsigned[name];
    const packaged = spawnSync(process.execPath, ["run", "package:desktop"], {
      cwd: root,
      env: { ...unsigned, OCTANT_PACKAGE_FLAVOR: "nightly", OCTANT_RELEASE_VERSION: version },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 1_800_000,
    });
    if (packaged.status !== 0) throw new Error("Packaging Octant Nightly failed.");
  }
  const bundle = stagePackagedAppBundle(sourceBundle);
  stagedBundle = bundle;
  const executable = join(bundle, "Contents/MacOS", identity.productName);

  const bundleId = plistValue(bundle, "CFBundleIdentifier");
  const shortVersion = plistValue(bundle, "CFBundleShortVersionString");
  const signature = spawnSync("/usr/bin/codesign", ["-dv", bundle], { encoding: "utf8" });
  const signed = `${signature.stdout}${signature.stderr}`;
  const developerId = /Authority=Developer ID Application/.test(signed);
  checks.push({
    check: "1. Bundle is Octant Nightly at the dated preview version, without a Developer ID",
    status:
      bundleId === identity.bundleId && (reuse || shortVersion === version) && !developerId
        ? "pass"
        : "fail",
    detail: `${bundleId} ${shortVersion}; ${/Signature=adhoc/.test(signed) ? "ad-hoc signed" : developerId ? "Developer ID" : "not signed"}`,
  });

  // Electron's application folders follow the home CoreFoundation reports.
  const environment = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
  {
    const { child, outputTail } = spawnPackagedApplication({ executable, env: environment });
    running.add(child);
    if (child.pid !== undefined) started.set(child.pid, "packaged Nightly (client role)");
    try {
      let text = "";
      let readable = false;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && child.exitCode === null) {
        const read = spawnSync(
          "/usr/bin/osascript",
          [
            "-e",
            `tell application "System Events" to tell (first process whose unix id is ${child.pid}) to get value of every static text of window 1`,
          ],
          { encoding: "utf8", timeout: 5_000 },
        );
        if (read.status === 0) {
          readable = true;
          text = read.stdout.trim();
          if (text.length > 0) break;
        } else if (/not allowed assistive access|1719|1002/.test(read.stderr)) break;
        await new Promise((done) => setTimeout(done, 500));
      }
      // Without Accessibility access the alert can still be read by another
      // tool while the smoke holds it open for the named time.
      const hold = Number(process.env.OCTANT_NIGHTLY_PACKAGED_SMOKE_HOLD_ALERT_MS ?? "0");
      if (!readable && hold > 0) {
        console.log(`Holding the refusal alert of process ${child.pid} for ${hold}ms.`);
        await new Promise((done) => setTimeout(done, Math.min(hold, 300_000)));
      }
      const refused = /development build/.test(text) && /signed release/.test(text);
      checks.push({
        check: "2. An ordinary launch refuses as an unsigned development build",
        status: refused ? "pass" : readable ? "fail" : "unverified",
        detail: refused
          ? text
          : readable
            ? `alert read: ${JSON.stringify(text)} ${outputTail().slice(-300)}`
            : "System Events could not read the alert (no Accessibility access)",
      });
    } finally {
      await stop(child);
    }
  }

  {
    const storage = join(home, "Library", "Application Support", identity.windowStorageName);
    await mkdir(storage, { recursive: true, mode: 0o700 });
    await writeFile(join(storage, "data-choice.json"), JSON.stringify({ data: "test-data" }));
    const port = await freePort();
    const { child, outputTail } = spawnPackagedApplication({
      executable,
      env: { ...environment, OCTANT_SERVER_PORT: String(port) },
    });
    running.add(child);
    if (child.pid !== undefined) started.set(child.pid, "packaged Nightly (test host)");
    const began = Date.now();
    let beforeStop = "running";
    let ready = false;
    let members: ReadonlyArray<number> = [];
    try {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && child.exitCode === null && !ready) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(500),
          });
          const health = (await response.json()) as Record<string, unknown>;
          ready = response.ok && health.storage === "ready";
        } catch {
          // Not listening yet.
        }
        if (!ready) await new Promise((done) => setTimeout(done, 250));
      }
      beforeStop = String(child.exitCode ?? child.signalCode ?? "running");
      if (child.pid !== undefined) members = groupMembers(child.pid);
    } finally {
      await stop(child);
    }
    const testData = join(storage, "Test Data");
    const listening = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    }).then(
      () => true,
      () => false,
    );
    const survivors = members.filter(alive);
    checks.push({
      check: "3. The packaged test host starts on the throwaway home's test data, then stops",
      status:
        ready && existsSync(testData) && !listening && survivors.length === 0 ? "pass" : "fail",
      detail: `ready=${ready} before-stop=${beforeStop} after=${Math.round((Date.now() - began) / 1_000)}s test-data=${existsSync(testData)} port-closed=${!listening} group=${members.length} survivors=${survivors.length}${ready ? "" : ` ${outputTail().slice(-400)}`}`,
    });
  }
} catch (error) {
  checks.push({
    check: "smoke",
    status: "fail",
    detail: error instanceof Error ? error.message : String(error),
  });
} finally {
  await finish();
}
process.exit(exitCode);

function finish(): Promise<void> {
  finishing ??= (async () => {
    // Launching the staged copy registered it, and its link scheme, with
    // Launch Services; the copy is removed at exit, so its record goes too.
    if (stagedBundle !== undefined)
      spawnSync(LSREGISTER, ["-u", stagedBundle], { stdio: "ignore", timeout: 20_000 });
    await rm(home, { recursive: true, force: true });
    if (!keep && existsSync(outDirectory))
      for (const entry of readdirSync(outDirectory))
        if (!before.has(entry))
          await rm(join(outDirectory, entry), { recursive: true, force: true });
    if (!realStorageExisted && existsSync(realStorage))
      checks.push({
        check: "isolation",
        status: "fail",
        detail: `${realStorage} appeared during the run; the throwaway home was not honored`,
      });
    const survivors = [...started.keys()].filter(alive);
    if (survivors.length > 0)
      checks.push({
        check: "cleanup",
        status: "fail",
        detail: `still running: ${survivors.join(", ")}`,
      });
    for (const check of checks)
      console.log(
        `${check.status.padEnd(10)} ${check.check}${check.detail ? ` — ${check.detail}` : ""}`,
      );
    if (checks.some((check) => check.status === "fail")) exitCode = 1;
  })();
  return finishing;
}
