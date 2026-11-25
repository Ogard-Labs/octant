import { describe, expect, it, vi } from "vitest";
import { postWithTypedClaim, sendWithTypedClaim, withoutTypedClaim } from "./typedClaim";
import {
  armedTypedClaimFor,
  armTypedClaim,
  composerTextReplaced,
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
  it("claims only text the scope's own input left, and nothing a button wrote", () => {
    forgetTypedComposerText();
    expect(typedClaimFor("chat:a", "A template's text")).toEqual({});

    noteTypedComposerText("chat:a", "I prefer short answers.");

    expect(typedClaimFor("chat:a", "  I prefer short answers.\n")).toEqual({ typedByPerson: true });
    expect(composerTextWasTyped("chat:a", "A template's text")).toBe(false);
  });

  it("never lets typing in one composer count for the same words in another", () => {
    forgetTypedComposerText();
    noteTypedComposerText("chat:a", "I prefer tabs");

    expect(composerTextWasTyped("chat:b", "I prefer tabs")).toBe(false);
    expect(composerTextWasTyped("composer:instance", "I prefer tabs")).toBe(false);
  });

  it("keeps a draft's note however much is typed in other composers", () => {
    forgetTypedComposerText();
    noteTypedComposerText("chat:a", "I prefer tabs");
    for (let index = 0; index < 100; index += 1) {
      noteTypedComposerText(`chat:other-${String(index)}`, `message ${String(index)}`);
    }

    expect(composerTextWasTyped("chat:a", "I prefer tabs")).toBe(true);
  });

  it("holds only the last text, forgets it when a button replaces the draft, and keeps it for the person's own restored draft", () => {
    forgetTypedComposerText();
    noteTypedComposerText("chat:a", "First draft");
    noteTypedComposerText("chat:a", "Second draft");
    expect(composerTextWasTyped("chat:a", "First draft")).toBe(false);

    // A thread switch brings the same draft back: the note stays.
    composerTextReplaced("chat:a", "Second draft");
    expect(composerTextWasTyped("chat:a", "Second draft")).toBe(true);

    // A button writes other text, and later the same words as the person's: not typed.
    composerTextReplaced("chat:a", "Prefilled by a button");
    composerTextReplaced("chat:a", "Second draft");
    expect(composerTextWasTyped("chat:a", "Second draft")).toBe(false);
  });

  it("answers a new-task send with the claim its own composer armed, once, for exactly that text", () => {
    forgetTypedComposerText();
    noteTypedComposerText("new-task:a", "I prefer tabs");

    armTypedClaim("new-task:a", "I prefer tabs");
    expect(armedTypedClaimFor("something else")).toEqual({});
    armTypedClaim("new-task:a", "I prefer tabs");
    expect(armedTypedClaimFor("I prefer tabs")).toEqual({ typedByPerson: true });
    expect(armedTypedClaimFor("I prefer tabs")).toEqual({});

    // Another composer's submit of the same words, which nobody typed, leaves nothing to find.
    armTypedClaim("new-task:a", "I prefer tabs");
    armTypedClaim("new-task:b", "I prefer tabs");
    expect(armedTypedClaimFor("I prefer tabs")).toEqual({});
  });
});
