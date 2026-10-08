/**
 * Local macOS Keychain smoke for the replica device key. Not part of any
 * test project: run directly with bunx tsx on a Mac with the built helper.
 */
import { generateKeyPairSync } from "node:crypto";
import { makeKeychainCredentialStore } from "../apps/desktop/src/keychainCredentialStore";
import {
  createReplicaDeviceKey,
  makeReplicaDeviceSigner,
  replicaInstanceIdOf,
  verifyReplicaEntrySignature,
} from "../apps/server/src/replica/replicaDeviceKeyService";

const helper = process.argv[2];
const storeScope = process.argv[3];
if (helper === undefined || storeScope === undefined) {
  console.error("usage: tsx replicaDeviceKey.local-smoke.mts <helperPath> <storeScopeUUID>");
  process.exit(2);
}
const store = makeKeychainCredentialStore(helper, { storeScope, namespace: "replica-device-key" });
const providers = makeKeychainCredentialStore(helper, { storeScope });
const key = await createReplicaDeviceKey(store);
const instanceId = key.instanceId;
const idCertified = replicaInstanceIdOf(key.publicKey) === instanceId;
console.log("create.publicKey:", key.publicKey.slice(0, 24) + "...");
console.log("create.fingerprint:", key.fingerprint);
console.log("create.instanceId is the key's id:", idCertified);

const signer = makeReplicaDeviceSigner(store, instanceId);
const payload = new TextEncoder().encode("octant.replica-entry/2 smoke\n");
const { signature } = await signer.sign(payload);
console.log("sign.signature bytes:", signature.length);

const verified = verifyReplicaEntrySignature({
  publicKeyBase64: key.publicKey,
  payload,
  signatureBase64: signature,
});
console.log("verify(roundtrip):", verified);

const tampered = verifyReplicaEntrySignature({
  publicKeyBase64: key.publicKey,
  payload: new TextEncoder().encode("tampered"),
  signatureBase64: signature,
});
console.log("verify(tampered):", tampered);

// A provider credential named with the same instance UUID lives in another
// Keychain service: it cannot read, replace, or delete the device key.
const providerSeesKey = await providers.has(instanceId);
console.log("provider.has(same id):", providerSeesKey);
await providers.set(instanceId, "provider-secret");
await providers.delete(instanceId);
const afterProvider = await makeReplicaDeviceSigner(store, instanceId).sign(payload);
const keyUntouched = verifyReplicaEntrySignature({
  publicKeyBase64: key.publicKey,
  payload,
  signatureBase64: afterProvider.signature,
});
console.log("device key unchanged after provider set+delete:", keyUntouched);

const other = generateKeyPairSync("ed25519");
const wrongKey = verifyReplicaEntrySignature({
  publicKeyBase64: other.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  payload,
  signatureBase64: signature,
});
console.log("verify(wrong key):", wrongKey);

await store.delete(instanceId);
console.log("cleanup: deleted");
const gone = !(await store.has(instanceId));
console.log("cleanup: device key absent:", gone);
process.exit(
  idCertified && verified && !tampered && !wrongKey && !providerSeesKey && keyUntouched && gone
    ? 0
    : 1,
);
