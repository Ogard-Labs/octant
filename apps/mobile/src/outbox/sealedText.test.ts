import { describe, expect, it } from "vitest";
import { createSealedText } from "./sealedText";

function phone() {
  const secure = new Map<string, string>();
  let file: string | null = null;
  return {
    secure,
    sealed: () => file,
    tamper: (next: string | null) => {
      file = next;
    },
    text: () =>
      createSealedText({
        crypto: globalThis.crypto,
        storage: {
          getItem: async (key) => secure.get(key) ?? null,
          setItem: async (key, value) => void secure.set(key, value),
          deleteItem: async (key) => void secure.delete(key),
        },
        file: {
          read: () => file,
          write: (next) => {
            file = next;
          },
          remove: () => {
            file = null;
          },
        },
      }),
  };
}

describe("text kept on the phone", () => {
  it("comes back after a restart, and is not readable where it lies", async () => {
    const held = phone();
    await held.text().keep("the secret plan ✓");
    expect(held.sealed()).not.toContain("secret");
    expect(atob(held.sealed() ?? "")).not.toContain("secret");
    expect(await held.text().load()).toBe("the secret plan ✓");
  });

  it("is let go when it was changed, or its key is gone", async () => {
    const changed = phone();
    await changed.text().keep("plan");
    changed.tamper(`${(changed.sealed() ?? "").slice(0, -4)}AAAA`);
    expect(await changed.text().load()).toBeNull();
    expect(changed.sealed()).toBeNull();

    const keyless = phone();
    await keyless.text().keep("plan");
    keyless.secure.clear();
    expect(await keyless.text().load()).toBeNull();
    expect(keyless.sealed()).toBeNull();
  });

  it("stays where it lies when the key cannot be read this time", async () => {
    const held = phone();
    await held.text().keep("plan");
    let fails = true;
    const text = createSealedText({
      crypto: globalThis.crypto,
      storage: {
        getItem: async (key) => {
          if (fails) throw new Error("The keychain did not answer.");
          return held.secure.get(key) ?? null;
        },
        setItem: async () => undefined,
        deleteItem: async () => undefined,
      },
      file: { read: held.sealed, write: () => undefined, remove: () => held.tamper(null) },
    });
    await expect(text.load()).rejects.toThrow();
    fails = false;
    expect(await text.load()).toBe("plan");
  });

  it("leaves neither text nor key behind once there is nothing to keep", async () => {
    const held = phone();
    const text = held.text();
    await text.keep("plan");
    await text.keep(undefined);
    expect(held.sealed()).toBeNull();
    expect(held.secure.size).toBe(0);
  });

  it("ends with the newest of several writes", async () => {
    const held = phone();
    const text = held.text();
    await Promise.all([text.keep("one"), text.keep("two"), text.keep("three")]);
    expect(await held.text().load()).toBe("three");
  });
});
