import { describe, expect, it, vi } from "vitest";
import { postWithTypedClaim, sendWithTypedClaim, withoutTypedClaim } from "./typedClaim";
import {
  composerTextReplaced,
  composerTextWasTyped,
  composerValueShown,
  forgetTypedComposerText,
  noteTypedComposerText,
  typedClaimFor,
  typedSendClaim,
  withTypedSend,
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

  it("keeps a note when a native field shows the person's earlier text late, and when two views share the draft, but not for a real replacement", () => {
    forgetTypedComposerText();
    noteTypedComposerText("mobile-home", "I prefer");
    noteTypedComposerText("mobile-home", "I prefer tabs");

    // The field reports the first keystroke's value after the second was typed;
    // the hidden sheet and the inline composer both see the new value.
    composerValueShown("mobile-home", "I prefer");
    composerValueShown("mobile-home", "I prefer tabs");
    composerValueShown("mobile-home", "I prefer tabs");
    expect(composerTextWasTyped("mobile-home", "I prefer tabs")).toBe(true);

    composerValueShown("mobile-home", "Prefilled by a button");
    expect(composerTextWasTyped("mobile-home", "I prefer tabs")).toBe(false);
  });

  it("hands a claim to the handler only for the length of the call that hands the text over", async () => {
    forgetTypedComposerText();
    noteTypedComposerText("new-task:a", "I prefer tabs");
    const seen: Array<{ typedByPerson?: true }> = [];
    const handler = async (text: string) => {
      seen.push(typedSendClaim(text));
      await Promise.resolve();
      // After its first await the claim is gone, and so is every other composer's.
      seen.push(typedSendClaim(text));
    };

    await withTypedSend(handler, "new-task:a", "I prefer tabs")("I prefer tabs");
    // Another composer sending the same words, which nobody typed there.
    await withTypedSend(handler, "new-task:b", "I prefer tabs")("I prefer tabs");
    // A handler given other text than the composer's claims nothing.
    await withTypedSend(handler, "new-task:a", "I prefer tabs")("something else");

    expect(seen).toEqual([{ typedByPerson: true }, {}, {}, {}, {}, {}]);
    expect(typedSendClaim("I prefer tabs")).toEqual({});
  });
});
