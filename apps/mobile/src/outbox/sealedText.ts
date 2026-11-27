import type { ExpoSecureStringStorage } from "@octant/client-runtime";

/** Where the sealed text lies. It is useless without the key, which lies apart. */
export interface SealedFile {
  readonly read: () => string | null;
  readonly write: (sealed: string) => void;
  readonly remove: () => void;
}

const IV_BYTES = 12;

const toBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (letter) => letter.charCodeAt(0));

/**
 * Text kept on the phone under a key in its secure storage, so a copy of the
 * app's files, a backup among them, holds nothing that can be read.
 */
export function createSealedText(ports: {
  readonly storage: ExpoSecureStringStorage;
  readonly file: SealedFile;
  readonly crypto: Pick<Crypto, "getRandomValues" | "subtle">;
  /** Each text has its own key, so letting one go leaves the others readable. */
  readonly keyName: string;
}): {
  readonly load: () => Promise<string | null>;
  readonly keep: (text: string | undefined) => Promise<void>;
} {
  const { crypto, file, keyName: KEY_NAME, storage } = ports;
  const imported = (raw: Uint8Array<ArrayBuffer>) =>
    crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const forget = async () => {
    file.remove();
    await storage.deleteItem(KEY_NAME);
  };
  // One write at a time: a slower, older one must not land last.
  let last: Promise<void> = Promise.resolve();
  const write = async (text: string | undefined) => {
    if (text === undefined) {
      await forget();
      return;
    }
    let raw = await storage.getItem(KEY_NAME);
    if (raw === null) {
      raw = toBase64(crypto.getRandomValues(new Uint8Array(32)));
      await storage.setItem(KEY_NAME, raw);
    }
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await imported(fromBase64(raw)),
        new TextEncoder().encode(text),
      ),
    );
    const whole = new Uint8Array(IV_BYTES + sealed.length);
    whole.set(iv);
    whole.set(sealed, IV_BYTES);
    file.write(toBase64(whole));
  };
  return {
    load: async () => {
      // After whatever is still being written.
      await last.catch(() => undefined);
      const sealed = file.read();
      if (sealed === null) return null;
      // A key that could not be read this time is not a key that is gone, so
      // this may throw and leave the text where it lies.
      const raw = await storage.getItem(KEY_NAME);
      if (raw === null) {
        await forget().catch(() => undefined);
        return null;
      }
      const key = await imported(fromBase64(raw));
      let text: ArrayBuffer;
      try {
        const whole = fromBase64(sealed);
        text = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: whole.slice(0, IV_BYTES) },
          key,
          whole.slice(IV_BYTES),
        );
      } catch {
        // Its seal is broken: never shown, never sent.
        await forget().catch(() => undefined);
        return null;
      }
      return new TextDecoder().decode(text);
    },
    keep: (text) => {
      last = last.then(
        () => write(text),
        () => write(text),
      );
      return last;
    },
  };
}
