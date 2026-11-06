import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CredentialStoreFailure } from "./credentialStore";
import {
  clearSecretServiceTestData,
  makeSecretServiceCredentialStore,
  SECRET_SERVICE_NAMESPACES,
} from "./secretServiceCredentialStore";

// Runs against a real unlocked keyring only where CI starts one (a
// gnome-keyring daemon inside its own D-Bus session); everywhere else the
// fake-executor suite covers the commands.
const realKeyring =
  process.platform === "linux" && process.env.OCTANT_SECRET_SERVICE_KEYRING_TEST === "1";

describe.skipIf(!realKeyring)("Secret Service keyring separation", () => {
  it("never lets Nightly test data and Octant's items read, replace or clear each other", async () => {
    const account = randomUUID();
    for (const namespace of SECRET_SERVICE_NAMESPACES) {
      const octant = makeSecretServiceCredentialStore({ namespace, timeoutMs: 10_000 });
      const testData = makeSecretServiceCredentialStore({
        namespace,
        family: "octant-nightly-test-data",
        timeoutMs: 10_000,
      });
      await octant.set(account, `octant-${namespace}`);
      expect(await testData.has(account)).toBe(false);
      await testData.set(account, `test-data-${namespace}`);
      expect(await octant.resolve(account)).toBe(`octant-${namespace}`);
      expect(await testData.resolve(account)).toBe(`test-data-${namespace}`);
      await testData.delete(account);
      expect(await octant.resolve(account)).toBe(`octant-${namespace}`);
      await testData.set(account, `test-data-${namespace}`);
    }
    await clearSecretServiceTestData({ timeoutMs: 10_000 });
    for (const namespace of SECRET_SERVICE_NAMESPACES) {
      const octant = makeSecretServiceCredentialStore({ namespace, timeoutMs: 10_000 });
      const testData = makeSecretServiceCredentialStore({
        namespace,
        family: "octant-nightly-test-data",
        timeoutMs: 10_000,
      });
      await expect(testData.resolve(account)).rejects.toBeInstanceOf(CredentialStoreFailure);
      expect(await octant.resolve(account)).toBe(`octant-${namespace}`);
      await octant.delete(account);
    }
  }, 120_000);
});
