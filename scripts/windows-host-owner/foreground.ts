import { homedir } from "node:os";
import { hostDefaultFolder, judgeDefaultFolder } from "../../apps/server/src/defaultFolder";
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

const [binding, profile, mode] = process.argv.slice(2);
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
let heldClient: number | undefined;
function check(value: boolean, name: string) {
  if (!value) throw Error(`Foreground proof failed: ${name}`);
  checks.push(name);
}
try {
  check(
    judgeDefaultFolder(hostDefaultFolder(homedir(), {}), homedir()).status === "accepted",
    "the actual Windows default folder passes native canonical inside-home admission",
  );
  check(
    judgeDefaultFolder(
      hostDefaultFolder(homedir(), {
        OCTANT_DEFAULT_FOLDER: process.env.SystemRoot ?? "C:\\Windows",
      }),
      homedir(),
    ).status === "refused",
    "the Windows default folder keeps an outside-home path refused",
  );
  const deadline = performance.now() + 22000;
  let receipt = await startup.readHostInfo();
  while (receipt === undefined && performance.now() < deadline && !joined) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    receipt = await startup.readHostInfo();
  }
  if (receipt === undefined) {
    const records = `${output}\n${errors}`
      .split("\n")
      .filter(
        (line) =>
          line.startsWith('{"product":"Octant","status":"failed"') ||
          line.startsWith('{"ownedFixtureStartupCause":'),
      );
    throw Error(`Foreground startup was not ready. ${records.join(" ")}`);
  }
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
  if (mode === "unresponsive-stop") {
    const ownerRecord = native.lookup(resolved.paths.profileId);
    if (
      typeof ownerRecord !== "object" ||
      ownerRecord === null ||
      !("secret" in ownerRecord) ||
      !(ownerRecord.secret instanceof Uint8Array) ||
      ownerRecord.secret.length !== 32
    )
      throw Error("The owned stop fixture could not read its private control material.");
    const material = Buffer.from(ownerRecord.secret);
    let command: Buffer;
    try {
      command = Buffer.from(
        JSON.stringify({
          version: 1,
          principal: "local",
          type: "stop",
          secret: material.toString("base64url"),
        }),
      );
    } finally {
      material.fill(0);
      ownerRecord.secret.fill(0);
    }
    try {
      const connectionDeadline = performance.now() + 2000;
      let opened = native.beginRequest(resolved.paths.profileId, command);
      while (
        typeof opened === "object" &&
        opened !== null &&
        "status" in opened &&
        opened.status === "busy" &&
        performance.now() < connectionDeadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        opened = native.beginRequest(resolved.paths.profileId, command);
      }
      if (
        typeof opened !== "object" ||
        opened === null ||
        !("status" in opened) ||
        opened.status !== "pending" ||
        !("id" in opened) ||
        typeof opened.id !== "number"
      )
        throw Error("The owned stop fixture could not connect.");
      heldClient = opened.id;
      const sent = native.pollRequest(heldClient);
      if (
        typeof sent !== "object" ||
        sent === null ||
        !("status" in sent) ||
        sent.status !== "pending"
      )
        throw Error("The owned stop fixture could not send its authenticated frame.");
    } finally {
      command.fill(0);
    }
    // The first poll writes only. Deliberately never poll/read the acknowledgement. The native transport's
    // existing deadline must finish this exact authenticated connection.
    const deadline = performance.now();
    try {
      check(
        (await exit) === 0 && performance.now() - deadline < 5000,
        "an authenticated peer that never reads its acknowledgement cannot hold the owner open",
      );
    } finally {
      if (heldClient !== undefined) {
        native.closeRequest(heldClient);
        heldClient = undefined;
      }
    }
  } else {
    check(
      await attached.attachment.requestStop(),
      "native owner control requests a graceful foreground drain",
    );
  }
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
  if (heldClient !== undefined) native.closeRequest(heldClient);
  child.stdin.end();
  if (!joined) child.kill();
  await exit.catch(() => undefined);
  native.close();
  clearTimeout(lifetime);
}
