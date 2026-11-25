import { describe, expect, it } from "vitest";
import {
  composerStashRecoveryKey,
  emptyComposerStashDraft,
  type ComposerStashLocation,
  type ComposerStashTarget,
} from "./composerStashDraft";
import { planComposerStashRecovery, planComposerStashRestore } from "./composerStashRestore";

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
  it("keeps one live new-task recovery across Project changes and isolates it from other windows", () => {
    const location = {
      ...chat,
      mode: "work" as const,
      threadId: null,
      composerId: "work-overview",
      windowId: "first-window",
    };
    expect(composerStashRecoveryKey({ ...location, projectId: "another-project" })).toBe(
      composerStashRecoveryKey(location),
    );
    expect(composerStashRecoveryKey({ ...location, windowId: "second-window" })).not.toBe(
      composerStashRecoveryKey(location),
    );
  });

  it("keeps extension selections in their original provider scope", () => {
    const location = { ...chat, threadId: null, extensionScope: "provider-one" };
    expect(
      planComposerStashRestore(
        location,
        { ...target, location: { ...location, extensionScope: "provider-two" } },
        emptyComposerStashDraft(),
        {
          ...emptyComposerStashDraft(),
          context: [
            {
              kind: "extension",
              value: {
                label: "Review",
                reference: "@review",
                status: { kind: "blocked", reason: "unavailable" },
              },
            },
          ],
        },
      ),
    ).toEqual({
      kind: "refused",
      reason: "Choose the original provider and Project to restore the extension selection.",
    });
  });

  it("replaces an untouched paired to-do prompt and keeps later edits when restoring the same link", () => {
    const location = { ...chat, threadId: null, composerId: "remote-todo" };
    const seed = "Check the release notes";
    const context = [
      {
        kind: "todo" as const,
        value: { todoId: "todo-1", title: seed, listHostId: "list-host" },
      },
    ];
    const saved = { ...emptyComposerStashDraft(), text: "Check the edited release notes", context };
    const targetForTodo = { ...target, location, context: ["todo"] as const, todoSeed: seed };
    const current = { ...emptyComposerStashDraft(), text: seed, context };

    expect(planComposerStashRestore(location, targetForTodo, current, saved)).toEqual({
      kind: "ready",
      draft: saved,
    });
    expect(
      planComposerStashRestore(location, targetForTodo, { ...current, text: "New edits" }, saved),
    ).toEqual({
      kind: "ready",
      draft: { ...saved, text: "New edits\n\n" + saved.text, caret: 11 },
    });
  });

  it("recovers a renamed to-do's draft, keeps its attachments, and preserves newer edits", () => {
    const location = { ...chat, threadId: null, composerId: "remote-todo" };
    const oldTitle = "Review release notes";
    const newTitle = "Review November release notes";
    const todo = { todoId: "todo-1", title: oldTitle, listHostId: "list-host" };
    const file = new File(["the exact attachment"], "notes.md", { type: "text/markdown" });
    const saved = {
      ...emptyComposerStashDraft(),
      text: "Review the rewritten release notes",
      caret: 9,
      files: [file],
      context: [{ kind: "todo" as const, value: todo }],
    };
    const record = { location, revision: "revision", beforeText: oldTitle, draft: saved };
    const targetForTodo = { ...target, location, context: ["todo"] as const, todoSeed: newTitle };
    const context = [{ kind: "todo" as const, value: { ...todo, title: newTitle } }];
    const current = { ...emptyComposerStashDraft(), text: newTitle, context };
    const edits = { ...current, text: "Newer edits", caret: 4 };

    expect(planComposerStashRecovery(record, targetForTodo, current)).toEqual({
      kind: "ready",
      draft: { ...saved, context },
    });
    expect(planComposerStashRecovery(record, targetForTodo, edits)).toEqual({
      kind: "ready",
      draft: { ...saved, context, text: edits.text, caret: edits.caret },
    });
    expect(
      planComposerStashRecovery(record, targetForTodo, {
        ...current,
        context: [{ kind: "todo", value: { ...todo, listHostId: "other-list" } }],
      }).kind,
    ).toBe("refused");
  });

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

  it("keeps both drafts when combining their selected context would exceed the turn limits", () => {
    const location = { ...chat, mode: "code" as const, binding: "checkout" };
    const draft = {
      ...emptyComposerStashDraft(),
      text: "Review these files",
      context: Array.from({ length: 5 }, (_, index) => ({
        kind: "file" as const,
        value: `file-${index}.md`,
      })),
    };
    expect(
      planComposerStashRestore(location, { ...target, location, context: ["file"] }, draft, {
        ...draft,
        context: draft.context.map((part) => ({ ...part, value: `saved-${part.value}` })),
      }),
    ).toEqual({
      kind: "refused",
      reason: "Remove a file mention before restoring this draft. This composer can hold 8.",
    });
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

  it("keeps a selected file path bound to its original checkout", () => {
    const location = { ...chat, mode: "code" as const, binding: "source-checkout" };
    const planned = planComposerStashRestore(
      location,
      { ...target, location: { ...location, binding: "different-checkout" }, context: ["file"] },
      emptyComposerStashDraft(),
      {
        ...emptyComposerStashDraft(),
        text: "Review src/entry.ts",
        context: [{ kind: "file", value: "src/entry.ts" }],
      },
    );
    expect(planned).toEqual({
      kind: "refused",
      reason: "A file mention needs its original composer.",
    });
  });

  it("keeps a linked to-do with the new task's original mode and Project", () => {
    const location = { ...chat, threadId: null, composerId: "new-task" };
    const draft = {
      ...emptyComposerStashDraft(),
      context: [
        {
          kind: "todo" as const,
          value: { todoId: "todo-1", title: "Check the release notes", listHostId: "list-host" },
        },
      ],
    };
    const inProject = { ...target, location, context: ["todo"] as const };
    expect(planComposerStashRestore(location, inProject, emptyComposerStashDraft(), draft)).toEqual(
      { kind: "ready", draft },
    );
    expect(
      planComposerStashRestore(
        location,
        { ...inProject, location: { ...location, projectId: "another-project" } },
        emptyComposerStashDraft(),
        draft,
      ),
    ).toEqual({ kind: "refused", reason: "A to-do link needs its original composer." });
  });
});
