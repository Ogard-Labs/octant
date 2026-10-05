/**
 * Local macOS Keychain smoke for the replica device key. Not part of any
 * test project: run directly with bunx tsx on a Mac with the built helper.
 */
import { generateKeyPairSync } from "node:crypto";
import { makeKeychainCredentialStore } from "../apps/desktop/src/keychainCredentialStore";
import {
  ensureReplicaDeviceKey,
  makeReplicaDeviceSigner,
  verifyReplicaEntrySignature,
} from "../apps/server/src/replica/replicaDeviceKeyService";

const helper = process.argv[2];
const storeScope = process.argv[3];
if (helper === undefined || storeScope === undefined) {
  console.error("usage: tsx replicaDeviceKey.local-smoke.mts <helperPath> <storeScopeUUID>");
  process.exit(2);
}
const store = makeKeychainCredentialStore(helper, { storeScope });
const instanceId = "99999999-9999-4999-8999-999999999999";

const key = await ensureReplicaDeviceKey(store, instanceId);
console.log("ensure.publicKey:", key.publicKey.slice(0, 24) + "...");
console.log("ensure.fingerprint:", key.fingerprint);

const signer = makeReplicaDeviceSigner(store, instanceId);
const payload = new TextEncoder().encode("octant.replica-entry/1 smoke\n");
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

const other = generateKeyPairSync("ed25519");
const wrongKey = verifyReplicaEntrySignature({
  publicKeyBase64: other.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  payload,
  signatureBase64: signature,
});
console.log("verify(wrong key):", wrongKey);

await store.delete(instanceId);
console.log("cleanup: deleted");
process.exit(verified && !tampered && !wrongKey ? 0 : 1);
