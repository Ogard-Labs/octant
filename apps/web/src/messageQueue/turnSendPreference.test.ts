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

  it("⌘↩ steers when the default is Queue, and queues when it is Steer", () => {
    expect(messageTiming("queue", false)).toBe("next-turn");
    expect(messageTiming("queue", true)).toBeUndefined();
    expect(messageTiming("steer", false)).toBeUndefined();
    expect(messageTiming("steer", true)).toBe("next-turn");
  });
});
