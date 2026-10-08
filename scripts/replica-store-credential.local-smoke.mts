/**
 * Local macOS Keychain smoke for a sync bucket's key pair. Not part of any
 * test project: run directly with bunx tsx on a Mac with the built helper.
 * It uses a made-up key pair; never pass a real one.
 */
import { makeKeychainCredentialStore } from "../apps/desktop/src/keychainCredentialStore";

const helper = process.argv[2];
const storeScope = process.argv[3];
if (helper === undefined || storeScope === undefined) {
  console.error(
    "usage: tsx replica-store-credential.local-smoke.mts <helperPath> <storeScopeUUID>",
  );
  process.exit(2);
}
const bucketKeys = makeKeychainCredentialStore(helper, {
  storeScope,
  namespace: "replica-store-credential",
});
const providers = makeKeychainCredentialStore(helper, { storeScope });
const deviceKeys = makeKeychainCredentialStore(helper, {
  storeScope,
  namespace: "replica-device-key",
});
const credentialRef = "88888888-8888-4888-8888-888888888888";
const first = JSON.stringify({ accessKeyId: "FAKEACCESSKEY1", secretAccessKey: "fake-secret-1" });
const second = JSON.stringify({ accessKeyId: "FAKEACCESSKEY2", secretAccessKey: "fake-secret-2" });
const results: Array<readonly [string, boolean]> = [];
const record = (name: string, passed: boolean): void => {
  results.push([name, passed]);
  console.log(`${name}:`, passed);
};

await bucketKeys.set(credentialRef, first);
record("set then has", await bucketKeys.has(credentialRef));
record("resolve returns the first key pair", (await bucketKeys.resolve(credentialRef)) === first);

await bucketKeys.set(credentialRef, second);
record(
  "replace then resolve returns the second",
  (await bucketKeys.resolve(credentialRef)) === second,
);

// A provider credential or a device key named with the same UUID lives in
// another Keychain service: neither can read, replace, or delete the key pair.
record("provider.has(same id) is false", !(await providers.has(credentialRef)));
record("device key namespace has(same id) is false", !(await deviceKeys.has(credentialRef)));
await providers.set(credentialRef, "provider-secret");
await providers.delete(credentialRef);
record(
  "key pair unchanged after provider set+delete",
  (await bucketKeys.resolve(credentialRef)) === second,
);
await deviceKeys.delete(credentialRef);
record(
  "key pair unchanged after device key delete",
  (await bucketKeys.resolve(credentialRef)) === second,
);

await bucketKeys.delete(credentialRef);
record("delete then has is false", !(await bucketKeys.has(credentialRef)));
record("provider item cleaned up", !(await providers.has(credentialRef)));
process.exit(results.every(([, passed]) => passed) ? 0 : 1);
