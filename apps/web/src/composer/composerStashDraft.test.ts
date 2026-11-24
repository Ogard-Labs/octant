import { describe, expect, it } from "vitest";
import {
  emptyComposerStashDraft,
  planComposerStashRestore,
  type ComposerStashLocation,
  type ComposerStashTarget,
} from "./composerStashDraft";

const chat: ComposerStashLocation = {
  host: "host",
  mode: "chat",
  projectId: "chat-project",
  composerId: "chat-thread",
  threadId: "chat-thread",
};

const target: ComposerStashTarget = {
  location: chat,
  attachmentLimit: 16,
  attachmentByteLimit: 10_485_760,
  readsImages: true,
  context: ["quote", "canvas", "preview", "thread", "extension"],
};

describe("restoring a saved composer draft", () => {
  it("restores an attachment-only draft into a compatible mode and keeps the original bytes", async () => {
    const file = new File(["hello from the saved draft"], "notes.md", { type: "text/markdown" });
    const restore = planComposerStashRestore(
      chat,
      { ...target, location: { ...chat, mode: "work", projectId: "work-project" } },
      emptyComposerStashDraft(),
      { ...emptyComposerStashDraft(), files: [file] },
    );

    expect(restore.kind).toBe("ready");
    if (restore.kind !== "ready") return;
    expect(await restore.draft.files[0]?.text()).toBe("hello from the saved draft");
    expect(restore.draft.files[0]?.name).toBe("notes.md");
  });

  it("restores quotes with their source and appends without replacing the live prompt", () => {
    const quote = {
      kind: "quote" as const,
      value: { id: "quote", turnId: "turn", text: "Exact excerpt" },
    };
    const saved = {
      ...emptyComposerStashDraft(),
      text: "Saved follow-up",
      caret: 5,
      context: [quote],
    };
    expect(
      planComposerStashRestore(
        chat,
        target,
        { ...emptyComposerStashDraft(), text: "New text" },
        saved,
      ),
    ).toEqual({
      kind: "ready",
      draft: { ...saved, text: "New text\n\nSaved follow-up", caret: 15 },
    });
  });

  it("refuses to relabel a quote as a reply from a different conversation", () => {
    const saved = {
      ...emptyComposerStashDraft(),
      context: [
        { kind: "quote" as const, value: { id: "quote", turnId: "turn", text: "Exact excerpt" } },
      ],
    };
    expect(
      planComposerStashRestore(
        chat,
        { ...target, location: { ...chat, composerId: "other-thread", threadId: "other-thread" } },
        emptyComposerStashDraft(),
        saved,
      ),
    ).toEqual({ kind: "refused", reason: "A quoted reply needs its original composer." });
  });

  it("refuses an append when its last file would exceed the destination limit", () => {
    const file = new File(["bytes"], "notes.md");
    const draft = { ...emptyComposerStashDraft(), files: [file] };
    expect(planComposerStashRestore(chat, { ...target, attachmentLimit: 1 }, draft, draft)).toEqual(
      {
        kind: "refused",
        reason: "This composer can hold 1 attachment. Remove an attachment before restoring.",
      },
    );
  });

  it("keeps a draft within the host that owns its source scope", () => {
    expect(
      planComposerStashRestore(
        chat,
        { ...target, location: { ...chat, host: "other-host" } },
        emptyComposerStashDraft(),
        { ...emptyComposerStashDraft(), text: "private draft" },
      ).kind,
    ).toBe("refused");
  });
});
