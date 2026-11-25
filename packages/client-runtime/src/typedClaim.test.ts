import { describe, expect, it, vi } from "vitest";
import { postWithTypedClaim, sendWithTypedClaim, withoutTypedClaim } from "./typedClaim";
import {
  composerTextWasTyped,
  forgetTypedComposerText,
  noteTypedComposerText,
  typedClaimFor,
} from "./typedComposerText";

describe("a send that claims the person typed it", () => {
  const refused = (error: unknown) => error instanceof Error && error.message === "invalid";

  it("is sent once more without the claim when an older host refuses the unknown field", async () => {
    const send = vi.fn(
      async (command: { readonly prompt: string; readonly typedByPerson?: true }) => {
        if (command.typedByPerson === true) throw new Error("invalid");
        return "delivered";
      },
    );

    await expect(
      sendWithTypedClaim({ prompt: "Hello", typedByPerson: true as const }, send, refused),
    ).resolves.toBe("delivered");

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual({ prompt: "Hello" });
  });

  it("is not sent twice for any other refusal, or when it made no claim", async () => {
    const failing = vi.fn(async () => {
      throw new Error("unavailable");
    });
    await expect(
      sendWithTypedClaim({ prompt: "Hello", typedByPerson: true as const }, failing, refused),
    ).rejects.toThrow("unavailable");
    expect(failing).toHaveBeenCalledTimes(1);

    const invalid = vi.fn(async () => {
      throw new Error("invalid");
    });
    await expect(sendWithTypedClaim({ prompt: "Hello" }, invalid, refused)).rejects.toThrow(
      "invalid",
    );
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it("is sent once more without the claim when a host answers a response with 400", async () => {
    const post = vi.fn(async (body: object) => ({
      status: "typedByPerson" in body ? 400 : 200,
    }));

    const response = await postWithTypedClaim({ prompt: "Hi", typedByPerson: true }, post);

    expect(response.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("takes a queued message's claim out of its payload too", () => {
    expect(
      withoutTypedClaim({ kind: "enqueue", payload: { prompt: "Hi", typedByPerson: true } }),
    ).toEqual({ kind: "enqueue", payload: { prompt: "Hi" } });
  });
});

describe("what the person typed", () => {
  it("claims only text a composer's own input left, and nothing a button wrote", () => {
    forgetTypedComposerText();
    expect(typedClaimFor("A template's text")).toEqual({});

    noteTypedComposerText("I prefer short answers.");

    expect(typedClaimFor("  I prefer short answers.\n")).toEqual({ typedByPerson: true });
    expect(composerTextWasTyped("A template's text")).toBe(false);
  });

  it("keeps only the newest texts", () => {
    forgetTypedComposerText();
    for (let index = 0; index < 20; index += 1) noteTypedComposerText(`message ${String(index)}`);

    expect(composerTextWasTyped("message 0")).toBe(false);
    expect(composerTextWasTyped("message 19")).toBe(true);
  });
});
