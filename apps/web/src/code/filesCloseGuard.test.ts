import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Guard from "./filesCloseGuard";

let guard: typeof Guard;

// The registry is module state shared by every close path in the window;
// each test starts from the empty one.
beforeEach(async () => {
  vi.resetModules();
  guard = await import("./filesCloseGuard");
});

function entry(
  overrides: Partial<Guard.FilesCloseEntry> & Pick<Guard.FilesCloseEntry, "scope" | "key" | "name">,
): Guard.FilesCloseEntry {
  const state = { dirty: true };
  return {
    isDirty: () => state.dirty,
    save: vi.fn(async () => {
      state.dirty = false;
      return true;
    }),
    discard: vi.fn(() => {
      state.dirty = false;
    }),
    ...overrides,
  };
}

function answerPending(choice: "save" | "discard" | "cancel"): void {
  const prompt = guard.filesClosePromptSnapshot();
  expect(prompt).toBeDefined();
  prompt!.answer(choice);
}

describe("filesCloseGuard", () => {
  it("asks only the files of the scope being closed", async () => {
    const scopeA = guard.filesCloseScope(undefined, "thread-a");
    const scopeB = guard.filesCloseScope(undefined, "thread-b");
    const other = entry({ scope: scopeB, key: "k-b", name: "other.ts" });
    const releaseOther = guard.registerFilesCloseEntry(other);
    const own = entry({ scope: scopeA, key: "k-a", name: "draft.ts" });
    const releaseOwn = guard.registerFilesCloseEntry(own);
    try {
      const confirmed = guard.confirmFilesClose(scopeA);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("draft.ts"));
      answerPending("discard");
      expect(await confirmed).toBe(true);
      expect(own.discard).toHaveBeenCalledTimes(1);
      expect(other.save).not.toHaveBeenCalled();
      expect(other.discard).not.toHaveBeenCalled();
    } finally {
      releaseOther();
      releaseOwn();
    }
  });

  it("asks two dirty files once each, in registration order, honouring Save and Discard", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    const first = entry({ scope, key: "k-1", name: "one.ts" });
    const second = entry({ scope, key: "k-2", name: "two.ts" });
    const release = [guard.registerFilesCloseEntry(first), guard.registerFilesCloseEntry(second)];
    try {
      const confirmed = guard.confirmFilesClose(scope);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
      answerPending("save");
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("two.ts"));
      answerPending("discard");
      expect(await confirmed).toBe(true);
      expect(first.save).toHaveBeenCalledTimes(1);
      expect(first.discard).not.toHaveBeenCalled();
      expect(second.save).not.toHaveBeenCalled();
      expect(second.discard).toHaveBeenCalledTimes(1);
      expect(guard.filesClosePromptSnapshot()).toBeUndefined();
    } finally {
      for (const releaseEntry of release) releaseEntry();
    }
  });

  it("keeps everything open on Cancel without touching the remaining edits", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    const first = entry({ scope, key: "k-1", name: "one.ts" });
    const second = entry({ scope, key: "k-2", name: "two.ts" });
    const release = [guard.registerFilesCloseEntry(first), guard.registerFilesCloseEntry(second)];
    try {
      const confirmed = guard.confirmFilesClose(scope);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
      answerPending("cancel");
      expect(await confirmed).toBe(false);
      expect(first.save).not.toHaveBeenCalled();
      expect(first.discard).not.toHaveBeenCalled();
      expect(second.save).not.toHaveBeenCalled();
      expect(second.discard).not.toHaveBeenCalled();
    } finally {
      for (const releaseEntry of release) releaseEntry();
    }
  });

  it("says a save failed and asks again instead of closing", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    const failing = entry({
      scope,
      key: "k-1",
      name: "one.ts",
      save: vi.fn(async () => false),
    });
    const release = guard.registerFilesCloseEntry(failing);
    try {
      const confirmed = guard.confirmFilesClose(scope);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
      answerPending("save");
      await vi.waitFor(() =>
        expect(guard.filesClosePromptSnapshot()?.failure).toBe(
          "one.ts could not be saved. Your edits are still here.",
        ),
      );
      answerPending("cancel");
      expect(await confirmed).toBe(false);
      expect(failing.save).toHaveBeenCalledTimes(1);
      expect(failing.discard).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("refuses a second close attempt while the first is still asking", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    const pending = entry({ scope, key: "k-1", name: "one.ts" });
    const release = guard.registerFilesCloseEntry(pending);
    try {
      const confirmed = guard.confirmFilesClose(scope);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
      expect(await guard.confirmFilesClose(scope)).toBe(false);
      answerPending("discard");
      expect(await confirmed).toBe(true);
    } finally {
      release();
    }
  });

  it("closes clean files without asking anything", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    const clean = entry({ scope, key: "k-1", name: "one.ts", isDirty: () => false });
    const release = guard.registerFilesCloseEntry(clean);
    try {
      expect(await guard.confirmFilesClose(scope)).toBe(true);
      expect(guard.filesClosePromptSnapshot()).toBeUndefined();
      expect(clean.save).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("keeps a released dirty buffer registered and prunes a clean one", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    let dirty = true;
    const retained = entry({
      scope,
      key: "k-1",
      name: "one.ts",
      isDirty: () => dirty,
      discard: vi.fn(() => {
        dirty = false;
      }),
    });
    const releaseDirty = guard.registerFilesCloseEntry(retained);
    const clean = entry({ scope, key: "k-2", name: "two.ts", isDirty: () => false });
    const releaseClean = guard.registerFilesCloseEntry(clean);
    releaseDirty();
    releaseClean();
    const confirmed = guard.confirmFilesClose(scope);
    await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
    answerPending("discard");
    expect(await confirmed).toBe(true);
    expect(retained.discard).toHaveBeenCalledTimes(1);
    expect(clean.save).not.toHaveBeenCalled();
  });

  it("refuses when a dirty registration was replaced while its prompt was open", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    const original = entry({ scope, key: "k-1", name: "one.ts" });
    const releaseOriginal = guard.registerFilesCloseEntry(original);
    const replacement = entry({ scope, key: "k-1", name: "one.ts" });
    let releaseReplacement: (() => void) | undefined;
    try {
      const confirmed = guard.confirmFilesClose(scope);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
      // The editor remounted while the person was answering; the consent they
      // are about to give belongs to a registration that no longer stands.
      releaseReplacement = guard.registerFilesCloseEntry(replacement);
      answerPending("save");
      expect(await confirmed).toBe(false);
      expect(original.save).not.toHaveBeenCalled();
      expect(original.discard).not.toHaveBeenCalled();
      expect(replacement.save).not.toHaveBeenCalled();
      expect(replacement.discard).not.toHaveBeenCalled();
    } finally {
      releaseOriginal();
      releaseReplacement?.();
    }
  });

  it("asks about a file that turned dirty while the previous prompt was open", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    let secondDirty = false;
    const first = entry({ scope, key: "k-1", name: "one.ts" });
    const second = entry({ scope, key: "k-2", name: "two.ts", isDirty: () => secondDirty });
    const release = [guard.registerFilesCloseEntry(first), guard.registerFilesCloseEntry(second)];
    try {
      const confirmed = guard.confirmFilesClose(scope);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
      secondDirty = true;
      answerPending("discard");
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("two.ts"));
      answerPending("cancel");
      expect(await confirmed).toBe(false);
      expect(second.save).not.toHaveBeenCalled();
      expect(second.discard).not.toHaveBeenCalled();
    } finally {
      for (const releaseEntry of release) releaseEntry();
    }
  });

  it("refuses when the entry is re-registered dirty under an in-flight save", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    let settleSave: (value: boolean) => void = () => undefined;
    const original = entry({
      scope,
      key: "k-1",
      name: "one.ts",
      save: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            settleSave = resolve;
          }),
      ),
    });
    const releaseOriginal = guard.registerFilesCloseEntry(original);
    const replacement = entry({ scope, key: "k-1", name: "one.ts" });
    let releaseReplacement: (() => void) | undefined;
    try {
      const confirmed = guard.confirmFilesClose(scope);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
      answerPending("save");
      await vi.waitFor(() => expect(original.save).toHaveBeenCalledTimes(1));
      releaseReplacement = guard.registerFilesCloseEntry(replacement);
      settleSave(true);
      expect(await confirmed).toBe(false);
      expect(replacement.save).not.toHaveBeenCalled();
      expect(replacement.discard).not.toHaveBeenCalled();
    } finally {
      releaseOriginal();
      releaseReplacement?.();
    }
  });

  it("answers the open prompt Cancel when the abort signal fires", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    const target = entry({ scope, key: "k-1", name: "one.ts" });
    const release = guard.registerFilesCloseEntry(target);
    const abort = new AbortController();
    try {
      const confirmed = guard.confirmFilesClose(scope, undefined, abort.signal);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
      abort.abort();
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()).toBeUndefined());
      expect(await confirmed).toBe(false);
      expect(target.save).not.toHaveBeenCalled();
      expect(target.discard).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("asks a file tab about its own document only", async () => {
    const scope = guard.filesCloseScope(undefined, "thread");
    const own = entry({ scope, key: "k-1", name: "one.ts" });
    const sibling = entry({ scope, key: "k-2", name: "two.ts" });
    const release = [guard.registerFilesCloseEntry(own), guard.registerFilesCloseEntry(sibling)];
    try {
      const confirmed = guard.confirmFilesClose(scope, "k-1");
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("one.ts"));
      answerPending("discard");
      expect(await confirmed).toBe(true);
      expect(sibling.save).not.toHaveBeenCalled();
      expect(sibling.discard).not.toHaveBeenCalled();
    } finally {
      for (const releaseEntry of release) releaseEntry();
    }
  });

  it("scopes a missing host id to this computer", () => {
    expect(guard.filesCloseScope(undefined, "t")).toBe(
      JSON.stringify([String(LOCAL_HOST_ID), "t"]),
    );
    expect(guard.filesCloseScope("host-1", "t")).toBe(JSON.stringify(["host-1", "t"]));
  });

  // Two views of one buffer: the records differ in scope but share the key
  // and the dirty state the store actually holds.
  function sharedView(
    scope: string,
    shared: { dirty: boolean },
    name = "shared.ts",
    key = "shared-key",
  ): Guard.FilesCloseEntry {
    return entry({
      scope,
      key,
      name,
      isDirty: () => shared.dirty,
      save: vi.fn(async () => {
        shared.dirty = false;
        return true;
      }),
      discard: vi.fn(() => {
        shared.dirty = false;
      }),
    });
  }

  it("asks about a dirty file in a main-area tab's own scope", async () => {
    const tabScope = guard.filesCloseTabScope(undefined, "thread", "tab-1");
    const own = entry({ scope: tabScope, key: "k-1", name: "main.ts" });
    const sibling = entry({
      scope: guard.filesCloseScope(undefined, "thread"),
      key: "k-2",
      name: "files.ts",
    });
    const release = [guard.registerFilesCloseEntry(own), guard.registerFilesCloseEntry(sibling)];
    try {
      const confirmed = guard.confirmFilesClose(tabScope);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("main.ts"));
      answerPending("discard");
      expect(await confirmed).toBe(true);
      expect(own.discard).toHaveBeenCalledTimes(1);
      expect(sibling.save).not.toHaveBeenCalled();
      expect(sibling.discard).not.toHaveBeenCalled();
    } finally {
      for (const releaseEntry of release) releaseEntry();
    }
  });

  it("does not ask about a file another live view outside the target still shows", async () => {
    const tabScope = guard.filesCloseTabScope(undefined, "thread", "tab-1");
    const threadScope = guard.filesCloseScope(undefined, "thread");
    const shared = { dirty: true };
    const inTab = sharedView(tabScope, shared);
    const inFiles = sharedView(threadScope, shared);
    const release = [guard.registerFilesCloseEntry(inTab), guard.registerFilesCloseEntry(inFiles)];
    try {
      // Closing only the tab's view loses nothing: Files still shows it.
      expect(await guard.confirmFilesClose(tabScope)).toBe(true);
      expect(guard.filesClosePromptSnapshot()).toBeUndefined();
      expect(inTab.save).not.toHaveBeenCalled();
      expect(inTab.discard).not.toHaveBeenCalled();
      expect(inFiles.save).not.toHaveBeenCalled();
      expect(inFiles.discard).not.toHaveBeenCalled();
      expect(shared.dirty).toBe(true);
    } finally {
      shared.dirty = false;
      for (const releaseEntry of release) releaseEntry();
    }
  });

  it("asks about a file whose other view already unmounted", async () => {
    const tabScope = guard.filesCloseTabScope(undefined, "thread", "tab-1");
    const threadScope = guard.filesCloseScope(undefined, "thread");
    const shared = { dirty: true };
    const inTab = sharedView(tabScope, shared);
    const inFiles = sharedView(threadScope, shared);
    const releaseTab = guard.registerFilesCloseEntry(inTab);
    const releaseFiles = guard.registerFilesCloseEntry(inFiles);
    try {
      // The Files view unmounted with the draft: it can no longer spare the tab.
      releaseFiles();
      const confirmed = guard.confirmFilesClose(tabScope);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("shared.ts"));
      answerPending("discard");
      expect(await confirmed).toBe(true);
      expect(inTab.discard).toHaveBeenCalledTimes(1);
      expect(inFiles.save).not.toHaveBeenCalled();
      expect(inFiles.discard).not.toHaveBeenCalled();
    } finally {
      shared.dirty = false;
      releaseTab();
      releaseFiles();
    }
  });

  it("asks once for a file two closing views share, and one Save covers both", async () => {
    const tabScope = guard.filesCloseTabScope(undefined, "thread", "tab-1");
    const threadScope = guard.filesCloseScope(undefined, "thread");
    const shared = { dirty: true };
    const inTab = sharedView(tabScope, shared);
    const inFiles = sharedView(threadScope, shared);
    const release = [guard.registerFilesCloseEntry(inTab), guard.registerFilesCloseEntry(inFiles)];
    try {
      const confirmed = guard.confirmFilesClose([threadScope, tabScope]);
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("shared.ts"));
      answerPending("save");
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()).toBeUndefined());
      expect(await confirmed).toBe(true);
      expect(inTab.save).toHaveBeenCalledTimes(1);
      expect(inFiles.save).not.toHaveBeenCalled();
      expect(inFiles.discard).not.toHaveBeenCalled();
    } finally {
      for (const releaseEntry of release) releaseEntry();
    }
  });

  it("asks once for a file two views show when the whole window closes", async () => {
    const tabScope = guard.filesCloseTabScope(undefined, "thread", "tab-1");
    const threadScope = guard.filesCloseScope(undefined, "thread");
    const shared = { dirty: true };
    const inTab = sharedView(tabScope, shared);
    const inFiles = sharedView(threadScope, shared);
    const release = [guard.registerFilesCloseEntry(inTab), guard.registerFilesCloseEntry(inFiles)];
    try {
      const confirmed = guard.confirmFilesClose();
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()?.name).toBe("shared.ts"));
      answerPending("save");
      await vi.waitFor(() => expect(guard.filesClosePromptSnapshot()).toBeUndefined());
      expect(await confirmed).toBe(true);
      expect(inTab.save).toHaveBeenCalledTimes(1);
      expect(inFiles.save).not.toHaveBeenCalled();
      expect(inFiles.discard).not.toHaveBeenCalled();
    } finally {
      for (const releaseEntry of release) releaseEntry();
    }
  });
});
