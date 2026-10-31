import { describe, expect, it } from "vitest";
import { isKeyringAdvice, keyringAdvice } from "./keyringAdvice";

describe("keyring advice", () => {
  it("gives each cause its own sentence, saying what to do next", () => {
    const causes = [
      "locked",
      "no-login-collection",
      "no-service",
      "no-tool",
      "denied",
      "timed-out",
    ] as const;
    const sentences = causes.map((cause) => keyringAdvice({ category: "unavailable", cause }));
    expect(new Set(sentences).size).toBe(causes.length);
    for (const sentence of sentences) expect(sentence).toMatch(/try again\.|restart\.$/);
  });

  it("falls back to the category when the keyring gave no cause, and says nothing for a missing key", () => {
    expect(keyringAdvice({ category: "unavailable" })).toContain("could not reach");
    expect(keyringAdvice({ category: "failed" })).toContain("refused to keep the key");
    expect(keyringAdvice({ category: "invalid" })).toContain("Check it");
    expect(keyringAdvice({ category: "missing" })).toBeUndefined();
  });

  it("recognises only its own sentences, so a store diagnostic is never shown as advice", () => {
    const advice = keyringAdvice({ category: "unavailable", cause: "no-service" }) ?? "";
    expect(advice).not.toBe("");
    expect(isKeyringAdvice(advice)).toBe(true);
    expect(isKeyringAdvice("secret-tool: Cannot autolaunch D-Bus")).toBe(false);
  });
});
