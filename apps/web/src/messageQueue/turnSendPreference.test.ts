import { describe, expect, it } from "vitest";
import {
  messageTiming,
  readTurnSendPreference,
  writeTurnSendPreference,
} from "./turnSendPreference";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("what a message sent during a turn does", () => {
  it("steers by default and keeps this client's choice of Queue", () => {
    const storage = memoryStorage();
    expect(readTurnSendPreference(storage)).toBe("steer");
    writeTurnSendPreference("queue", storage);
    expect(readTurnSendPreference(storage)).toBe("queue");
  });

  it("falls back to Steer, and keeps a choice for this window, when the browser blocks storage", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    // A browser that blocks site data throws on reading `localStorage` itself.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
    try {
      expect(readTurnSendPreference()).toBe("steer");
      writeTurnSendPreference("queue");
      expect(readTurnSendPreference()).toBe("queue");
      writeTurnSendPreference("steer");
    } finally {
      if (before === undefined) Reflect.deleteProperty(globalThis, "localStorage");
      else Object.defineProperty(globalThis, "localStorage", before);
    }
  });

  it("⌘↩ steers when the default is Queue, and queues when it is Steer", () => {
    expect(messageTiming("queue", false)).toBe("next-turn");
    expect(messageTiming("queue", true)).toBeUndefined();
    expect(messageTiming("steer", false)).toBeUndefined();
    expect(messageTiming("steer", true)).toBe("next-turn");
  });
});
