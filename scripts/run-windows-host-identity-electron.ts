import { spawn } from "node:child_process";
import { basename, isAbsolute, join, resolve } from "node:path";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("Electron identity acceptance requires an owned Windows CI runner.");
const bundle = resolve(process.argv[2] ?? "");
const helper = resolve(process.argv[3] ?? "");
const fixture = resolve(process.argv[4] ?? "");
if (
  !isAbsolute(bundle) ||
  basename(bundle) !== "octant-host-identity-smoke.mjs" ||
  basename(helper) !== "octant-credential-helper.exe" ||
  basename(fixture) !== "windows-host-identity-fixture.ps1"
)
  throw new Error("Supply only the fixed owned identity acceptance artifacts.");

const child = spawn(resolve("node_modules/electron/dist/electron.exe"), [bundle, helper, fixture], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const output: Buffer[] = [];
let bytes = 0;
let failed = false;
let stopper: Promise<void> | undefined;
const stop = () => {
  failed = true;
  if (
    stopper !== undefined ||
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  // Only this still-owned child PID and its descendants may be terminated.
  const kill = spawn(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
    ["/PID", String(child.pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true },
  );
  stopper = new Promise<void>((accept) => {
    const timer = setTimeout(() => {
      kill.kill();
      child.kill();
    }, 5000);
    kill.once("error", () => {
      child.kill();
    });
    kill.once("close", () => {
      clearTimeout(timer);
      accept();
    });
  });
};
const deadline = setTimeout(stop, 300000);
// A failed native termination must fail the controller rather than leave an
// unbounded workflow or claim a joined child. The hosted runner retains its
// inherited tracking identity for last-resort cleanup on this failure path.
const hardDeadline = setTimeout(() => {
  console.error("Owned Electron cleanup is unverified.");
  process.exit(1);
}, 315000);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
child.stdout.on("data", (chunk: Buffer) => {
  bytes += chunk.length;
  if (bytes > 131072) {
    chunk.fill(0);
    stop();
  } else output.push(chunk);
});
child.stderr.on("data", (chunk: Buffer) => {
  bytes += chunk.length;
  chunk.fill(0);
  if (bytes > 131072) stop();
});
child.once("error", () => {
  failed = true;
});
const code = await new Promise<number | null>((accept) => child.once("close", accept));
clearTimeout(deadline);
process.removeListener("SIGTERM", stop);
process.removeListener("SIGINT", stop);
await stopper;
clearTimeout(hardDeadline);
const combined = Buffer.concat(output);
for (const chunk of output) chunk.fill(0);
let receipts: ReadonlyArray<unknown>;
try {
  receipts = combined
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
} catch {
  throw new Error("Malformed owned Electron acceptance receipt.");
} finally {
  combined.fill(0);
}
const results = receipts.filter(isRecord);
const runtime = results.filter(
  (value) =>
    value.platform === "win32" &&
    value.nonExportingProductionApi === true &&
    typeof value.electron === "string" &&
    value.electron.length > 0 &&
    Array.isArray(value.checks) &&
    value.checks.length > 0 &&
    value.hostAdmitted === false &&
    value.workCodeEnabled === false,
);
const cleanup = results.filter(
  (value) =>
    value.ownedIdentityCleanup === true &&
    typeof value.fixturesJoined === "number" &&
    value.fixturesJoined > 0 &&
    typeof value.rawHelpersJoined === "number" &&
    value.rawHelpersJoined > 0 &&
    typeof value.identityTargets === "number" &&
    value.identityTargets > 0 &&
    typeof value.genericTargets === "number" &&
    value.genericTargets > 0,
);
if (failed || code !== 0 || runtime.length !== 1 || cleanup.length !== 1)
  throw new Error("Electron did not produce its successful native identity and cleanup receipts.");
for (const value of [...cleanup, ...runtime]) console.log(JSON.stringify(value));
console.log(JSON.stringify({ ownedElectronProcessJoined: true, ownedElectronPipesClosed: true }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
