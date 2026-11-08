import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import { KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT } from "../../packages/host-runtime/src/desktopIdentity";
import {
  resolveWindowsHostProfile,
  loadWindowsHostProfileNative,
} from "../../packages/host-runtime/src/windowsHostProfile";
import { createWindowsHostStartup } from "../../packages/host-runtime/src/windowsHostStartup";
import { attachWindowsHostRuntimeOwner } from "../../packages/host-runtime/src/windowsHostOwner";

const [binding, profile] = process.argv.slice(2);
const entry = process.env.OCTANT_FOREGROUND_FIXTURE_ENTRY;
if (
  process.platform !== "win32" ||
  !binding ||
  !entry ||
  !win32.isAbsolute(entry) ||
  (profile !== "octant" && profile !== "nightly-test-data")
)
  throw Error("Supply the isolated foreground fixture artifacts.");
const native = loadWindowsHostProfileNative(win32.resolve(binding));
if (native === undefined) throw Error("Native foreground fixture unavailable.");
const resolved = resolveWindowsHostProfile({ native, profile, env: {} });
if (resolved.status !== "ready") throw Error("Native foreground profile unavailable.");
console.log(JSON.stringify({ fixtureScope: resolved.paths.profileId }));
const startup = createWindowsHostStartup(native, resolved.paths);
if (startup === undefined) throw Error("Native startup ports unavailable.");
const secret = randomBytes(32).toString("base64url");
const environment = { ...process.env };
for (const key of [
  "OCTANT_DATA_DIR",
  "OCTANT_LOGS_DIR",
  "OCTANT_FOREGROUND_FIXTURE_ENTRY",
  "OCTANT_CREDENTIAL_BROKER_URL",
  "OCTANT_CREDENTIAL_BROKER_TOKEN",
])
  delete environment[key];
Object.assign(environment, {
  [KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT]:
    profile === "octant" ? "octant" : "octant-nightly-test-data",
  OCTANT_HOST_SERVICE_MODE: "foreground",
  OCTANT_DESKTOP_BRIDGE_SECRET: secret,
  OCTANT_DESKTOP_PARENT_WATCH: "1",
  OCTANT_PACKAGED_RUNTIME: "1",
});
const child = spawn(process.execPath, [entry], {
  env: environment,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
let errors = "";
child.stdout.on("data", (bytes: Buffer) => {
  output = (output + bytes.toString("utf8")).slice(-16384);
});
child.stderr.on("data", (bytes: Buffer) => {
  errors = (errors + bytes.toString("utf8")).slice(-16384);
});
let joined = false;
const exit = new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => {
    joined = true;
    resolve(code);
  });
});
const lifetime = setTimeout(() => child.kill(), 30000);
const checks: string[] = [];
function check(value: boolean, name: string) {
  if (!value) throw Error(`Foreground proof failed: ${name}`);
  checks.push(name);
}
try {
  const deadline = performance.now() + 22000;
  let receipt = await startup.readHostInfo();
  while (receipt === undefined && performance.now() < deadline && !joined) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    receipt = await startup.readHostInfo();
  }
  if (receipt === undefined) throw Error(`Foreground startup was not ready. ${output} ${errors}`);
  check(
    receipt.hostId === resolved.paths.profileId,
    "the actual foreground entry publishes the native profile identity",
  );
  check(
    (await startup.readBridgeSecret()) === secret,
    "the actual child owner publishes its supplied bridge seed",
  );
  const attached = await attachWindowsHostRuntimeOwner({
    native,
    scope: resolved.paths.profileId,
    hostId: resolved.paths.profileId,
    wireVersion: "1",
  });
  if (attached.status !== "attached")
    throw Error("The actual foreground control owner could not be authenticated.");
  check(
    attached.attachment.owner.instanceId === receipt.instanceId,
    "native control and public discovery identify the same actual server",
  );
  const health = await fetch(new URL("/health", receipt.url), {
    signal: AbortSignal.timeout(3000),
  });
  const body: unknown = await health.json();
  check(
    health.ok &&
      typeof body === "object" &&
      body !== null &&
      "storage" in body &&
      body.storage === "ready",
    "the real server reports ready only after native journal migration",
  );
  const foreign = await fetch(new URL("/api/chat/bootstrap", receipt.url), {
    headers: { origin: "http://127.0.0.1:45678" },
    signal: AbortSignal.timeout(3000),
  });
  check(foreign.status === 403, "an unrelated loopback origin cannot acquire product authority");
  const backup = await attached.attachment.request({
    type: "backup",
    principal: "local",
    label: "foreground-proof",
  });
  check(
    backup?.ok === true && backup.backup?.outcome === "created",
    "the actual foreground owner creates a verified native journal backup",
  );
  check(
    await attached.attachment.requestStop(),
    "native owner control requests a graceful foreground drain",
  );
  check((await exit) === 0, "the actual server exits successfully after scoped drain");
  check(
    (await startup.readHostInfo()) === undefined &&
      (await startup.readBridgeSecret()) === undefined,
    "foreground shutdown clears only its owned discovery projections",
  );
  let listening = true;
  try {
    await fetch(new URL("/health", receipt.url), { signal: AbortSignal.timeout(1000) });
  } catch {
    listening = false;
  }
  check(!listening, "the owned foreground listener closes before completion");
  console.log(
    JSON.stringify({
      profile,
      profileId: resolved.paths.profileId,
      foregroundChecks: checks,
      ownedServerJoined: joined,
      runtime: process.versions,
      startupAdmitted: true,
      workCodeEnabled: false,
    }),
  );
} finally {
  child.stdin.end();
  if (!joined) child.kill();
  await exit.catch(() => undefined);
  native.close();
  clearTimeout(lifetime);
}
