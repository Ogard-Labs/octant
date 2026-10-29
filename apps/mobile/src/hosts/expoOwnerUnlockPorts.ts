import { createExpoBiometricAuthenticator } from "../security/expoBiometricAuthenticator";
import { createExpoSecureStringStorage } from "./expoSecureStorage";
import { createPhoneUnlockKey, type PhoneUnlockKey, type UnlockKeyVault } from "./ownerUnlockKey";

const PRIVATE_KEY_NAME = "octant.owner-unlock.private.v1";
const PUBLIC_KEY_NAME = "octant.owner-unlock.public.v1";
const KEYCHAIN_SERVICE = "octant.owner-unlock";
const AUTHENTICATION_PROMPT = "Unlock this action on your computer";

/**
 * The private key goes into expo-secure-store with `requireAuthentication`, so
 * every read asks the person for biometrics or the device passcode, and it is
 * kept on this phone only (never in a backup or on another device) and only
 * while a passcode is set.
 */
function createNativeVault(): UnlockKeyVault {
  const SecureStore = require("expo-secure-store") as typeof import("expo-secure-store");
  const options = {
    keychainService: KEYCHAIN_SERVICE,
    keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    requireAuthentication: true,
    authenticationPrompt: AUTHENTICATION_PROMPT,
  } as const;
  return {
    async read() {
      try {
        const value = await SecureStore.getItemAsync(PRIVATE_KEY_NAME, options);
        return value === null ? { status: "missing" } : { status: "read", pkcs8: value };
      } catch {
        // A cancelled or failed authentication throws; the key stays where it is.
        return { status: "refused" };
      }
    },
    write: (pkcs8) => SecureStore.setItemAsync(PRIVATE_KEY_NAME, pkcs8, options),
    remove: () => SecureStore.deleteItemAsync(PRIVATE_KEY_NAME, options),
  };
}

/** The phone's unlock key on a native build; absent in a browser or a test, which hold no secure store. */
export function createExpoPhoneUnlockKey(): PhoneUnlockKey | undefined {
  if (typeof document !== "undefined") return undefined;
  const publicStorage = createExpoSecureStringStorage();
  return createPhoneUnlockKey({
    vault: createNativeVault(),
    publicKey: {
      get: () => publicStorage.getItem(PUBLIC_KEY_NAME),
      set: (publicKey) => publicStorage.setItem(PUBLIC_KEY_NAME, publicKey),
      remove: () => publicStorage.deleteItem(PUBLIC_KEY_NAME),
    },
    presence: createExpoBiometricAuthenticator(),
  });
}
