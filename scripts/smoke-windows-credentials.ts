import { spawn } from "node:child_process";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { resolve } from "node:path";
import { resolveDesktopCredentialBackend } from "../apps/desktop/src/desktopCredentialStore";
import {
  startCredentialBroker,
  type CredentialBroker,
} from "../packages/host-runtime/src/credentialBroker";
import type { CredentialStore } from "../packages/host-runtime/src/credentialStore";
import {
  makeReplicaDeviceKeyBrokerClient,
  makeCredentialBrokerClient,
} from "../apps/server/src/providers/credentialBrokerClient";
import {
  createReplicaDeviceKey,
  makeReplicaDeviceSigner,
  removeReplicaDeviceKey,
} from "../apps/server/src/replica/replicaDeviceKeyService";
import { makeWindowsCredentialStore } from "../packages/host-runtime/src/windowsCredentialStore";

if (process.platform !== "win32") throw new Error("Credential acceptance requires native Windows.");
const helperPath = resolve(process.argv[2] ?? "");
if (!helperPath.endsWith("octant-credential-helper.exe"))
  throw new Error("Supply the owned native helper build.");
const scope = randomUUID();
const ref = randomUUID();
const store = (
  storeScope = scope,
  serviceFamily: "octant" | "octant-nightly-test-data" = "octant",
) => makeWindowsCredentialStore({ helperPath, storeScope, serviceFamily });
const primary = store();
const otherScope = store(randomUUID());
const nightly = store(scope, "octant-nightly-test-data");
const backend = async (
  storeScope = scope,
  serviceFamily: "octant" | "octant-nightly-test-data" = "octant",
) => {
  const result = await resolveDesktopCredentialBackend({
    platform: "win32",
    windowsCredentialHelperPath: helperPath,
    keychainHelperPath: "",
    storeScope,
    serviceFamily,
  });
  if (result.kind !== "credential-manager") throw new Error("Native backend unavailable.");
  return result;
};
const desktop = await backend();
const auxiliary = (value: typeof desktop) => [
  value.replicaDeviceKeys,
  value.replicaStoreCredentials,
  value.canvasPublicShareSecrets,
  value.mcpServerCredentials,
  value.desktopProviderCredentials,
  value.pushPlatformCredentials,
  value.sshKeys,
];
const auxiliaryStores = auxiliary(desktop);
const otherAuxiliary = auxiliary(await backend(randomUUID()));
const nightlyAuxiliary = auxiliary(await backend(scope, "octant-nightly-test-data"));
const owned: Array<{ store: CredentialStore; ref: string }> = [
  primary,
  nightly,
  otherScope,
  ...auxiliaryStores,
  ...otherAuxiliary,
  ...nightlyAuxiliary,
].map((store) => ({ store, ref }));
let broker: CredentialBroker | undefined;
const checks: string[] = [];
let cleanupConfirmed = false;
function requireValue(value: boolean, check: string) {
  if (!value) throw new Error(`Native credential check failed: ${check}`);
  checks.push(check);
}
async function refuses(action: () => Promise<unknown>, category: string) {
  try {
    await action();
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "category" in error &&
      error.category === category
    );
  }
  return false;
}

// Every target uses fresh opaque references. No enumerate, account lookup,
// actual provider key or pre-existing vault entry participates in this smoke.
try {
  requireValue(!(await primary.has(ref)), "owned target starts absent");
  requireValue(await refuses(() => primary.resolve(ref), "missing"), "absent read is missing");
  const first = "synthetic-native-λ-🔐-not-a-provider-key";
  await primary.set(ref, first);
  requireValue(
    (await primary.has(ref)) && (await primary.resolve(ref)) === first,
    "Unicode key round-trip",
  );
  requireValue(
    !(await otherScope.has(ref)) && !(await nightly.has(ref)),
    "store and flavor isolation",
  );
  await nightly.set(ref, "synthetic-nightly-only");
  await otherScope.set(ref, "synthetic-other-store-only");
  const boundary = "λ".repeat(1280);
  await primary.set(ref, boundary);
  requireValue((await primary.resolve(ref)) === boundary, "atomic replacement at 2560 bytes");
  requireValue(
    (await refuses(() => primary.set(ref, boundary + "x"), "invalid")) &&
      (await primary.resolve(ref)) === boundary,
    "overflow refused without replacing the key",
  );
  requireValue(
    await refuses(() => primary.set("../other-target", "synthetic"), "invalid"),
    "invalid reference refused",
  );
  requireValue(
    (await nightly.resolve(ref)) === "synthetic-nightly-only" &&
      (await otherScope.resolve(ref)) === "synthetic-other-store-only",
    "isolated replacements preserved",
  );

  const frame = Buffer.alloc(85);
  frame.write("OCCR");
  frame[4] = 2;
  frame[5] = 1;
  frame.write(scope, 7, "ascii");
  frame.write(ref, 43, "ascii");
  frame.writeUInt32LE(1, 79);
  frame[83] = 0;
  frame[84] = 65;
  const nativeRefuses = async (input: Buffer) =>
    await new Promise<boolean>((resolveReply, reject) => {
      const child = spawn(helperPath, [], {
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill();
      }, 5_000);
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 9) {
          failed = true;
          child.kill();
        } else chunks.push(chunk);
      });
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks);
        const refused =
          code === 0 &&
          output.length === 9 &&
          output.toString("ascii", 0, 4) === "OCCR" &&
          output[4] === 2 &&
          output.readUInt32LE(5) === 0;
        for (const chunk of chunks) chunk.fill(0);
        output.fill(0);
        if (failed) reject(new Error("Owned protocol probe failed to exit cleanly."));
        else resolveReply(refused);
      });
      child.stdin.end(input);
    });
  const invalidReference = Buffer.from(frame);
  invalidReference[43] = 46;
  const extra = Buffer.concat([frame, Buffer.from([0])]);
  const oversized = Buffer.from(frame.subarray(0, 84));
  oversized.writeUInt32LE(2561, 79);
  const oldVersion = Buffer.from(frame);
  oldVersion[4] = 1;
  const unknownPurpose = Buffer.from(frame);
  unknownPurpose[83] = 8;
  const wrongFamily = Buffer.from(frame);
  wrongFamily[6] = 2;
  requireValue(
    (await nativeRefuses(oldVersion)) &&
      (await nativeRefuses(unknownPurpose)) &&
      (await nativeRefuses(wrongFamily)) &&
      (await nativeRefuses(invalidReference)) &&
      (await nativeRefuses(extra)) &&
      (await nativeRefuses(oversized)),
    "native malformed frames refused before mutation",
  );
  requireValue(
    (await primary.resolve(ref)) === boundary,
    "malformed requests preserved existing key",
  );
  for (const [index, auxiliaryStore] of auxiliaryStores.entries()) {
    const isolated = otherAuxiliary[index];
    const testData = nightlyAuxiliary[index];
    if (isolated === undefined || testData === undefined)
      throw new Error("Incomplete owned fixture.");
    requireValue(
      !(await auxiliaryStore.has(ref)) &&
        (await refuses(() => auxiliaryStore.resolve(ref), "missing")),
      `auxiliary ${index + 1} starts missing`,
    );
    await auxiliaryStore.set(ref, `synthetic-purpose-${index}-λ`);
    requireValue(
      !(await isolated.has(ref)) && !(await testData.has(ref)),
      `auxiliary ${index + 1} scope and family isolation`,
    );
    await isolated.set(ref, "synthetic-other-scope");
    await testData.set(ref, "synthetic-nightly");
  }
  for (const [index, auxiliaryStore] of auxiliaryStores.entries()) {
    requireValue(
      (await auxiliaryStore.resolve(ref)) === `synthetic-purpose-${index}-λ`,
      `auxiliary ${index + 1} namespace isolation`,
    );
    await auxiliaryStore.set(ref, boundary);
    const nativeOverflow = Buffer.from(oversized);
    nativeOverflow[83] = index + 1;
    requireValue(
      (await refuses(() => auxiliaryStore.set(ref, boundary + "x"), "invalid")) &&
        (await nativeRefuses(nativeOverflow)) &&
        (await auxiliaryStore.resolve(ref)) === boundary,
      `auxiliary ${index + 1} native and adapter overflow preserve 2560-byte value`,
    );
    await auxiliaryStore.delete(ref);
    requireValue(
      !(await auxiliaryStore.has(ref)) &&
        (await otherAuxiliary[index]?.resolve(ref)) === "synthetic-other-scope" &&
        (await nightlyAuxiliary[index]?.resolve(ref)) === "synthetic-nightly" &&
        (await primary.resolve(ref)) === boundary,
      `auxiliary ${index + 1} deletion preserves other stores and provider`,
    );
  }
  broker = await startCredentialBroker(
    desktop.store,
    undefined,
    undefined,
    desktop.replicaDeviceKeys,
    desktop.replicaStoreCredentials,
    desktop.canvasPublicShareSecrets,
    desktop.mcpServerCredentials,
    desktop.desktopProviderCredentials,
    desktop.pushPlatformCredentials,
    undefined,
    desktop.sshKeys,
  );
  const options = {
    url: broker.url,
    token: broker.token,
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(5_000) }),
  };
  const replica = makeReplicaDeviceKeyBrokerClient(options);
  const trackedReplica: CredentialStore = {
    ...replica,
    set: async (keyRef, value) => {
      owned.push({ store: desktop.replicaDeviceKeys, ref: keyRef });
      await replica.set(keyRef, value);
    },
  };
  const key = await createReplicaDeviceKey(trackedReplica);
  const payload = Buffer.from("synthetic owned replica acceptance");
  const signed = await makeReplicaDeviceSigner(replica, key.instanceId).sign(payload);
  requireValue(
    signed.status === "signed" &&
      verify(
        null,
        payload,
        createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" }),
        Buffer.from(signed.signature, "base64"),
      ),
    "existing replica consumer generates and signs through native broker",
  );
  requireValue(
    !(await makeCredentialBrokerClient(options).has(key.instanceId)),
    "provider route cannot reach replica private key",
  );
  const unauthenticated = await fetch(new URL("/v1/replica-device-keys/has", broker.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId: key.instanceId }),
    signal: AbortSignal.timeout(5_000),
  });
  await unauthenticated.arrayBuffer();
  requireValue(
    unauthenticated.status === 401,
    "native replica route refuses unauthenticated access",
  );
  await removeReplicaDeviceKey(replica, key.instanceId);
  requireValue(
    !(await replica.has(key.instanceId)) &&
      (await makeReplicaDeviceSigner(replica, key.instanceId).sign(payload)).status === "refused",
    "replica deletion revokes signing through the existing consumer",
  );
  await primary.delete(ref);
  requireValue(!(await primary.has(ref)), "explicit delete removes only owned target");
} finally {
  // No target is retained even after a failed scenario. A cleanup error fails CI.
  const cleanup = await Promise.allSettled(owned.map(({ store, ref }) => store.delete(ref)));
  await broker?.close();
  const absence = await Promise.allSettled(owned.map(({ store, ref }) => store.has(ref)));
  cleanupConfirmed =
    cleanup.every((result) => result.status === "fulfilled") &&
    absence.every((result) => result.status === "fulfilled" && !result.value);
  console.log(
    JSON.stringify({
      ownedCredentialCleanupConfirmed: cleanupConfirmed,
      ownedTargetCount: owned.length,
      brokerClosed: true,
    }),
  );
  requireValue(cleanupConfirmed, "all owned targets confirmed absent");
}
console.log(
  JSON.stringify({
    platform: process.platform,
    checks,
    cleanup: true,
    hostAdmitted: false,
    workCodeEnabled: false,
  }),
);
