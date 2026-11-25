import {
  composerTextReplaced,
  composerTextWasTyped,
  forgetTypedComposerText,
  noteTypedComposerText,
} from "@octant/client-runtime/typed-composer-text";
import { act, renderHook } from "@testing-library/react";
import { createRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerStashDraft } from "./composerStashDraft";
import type { SavedComposerDraft } from "./composerStashStore";
import { useComposerStash } from "./useComposerStash";
import { useNewTaskComposerStash } from "./useNewTaskComposerStash";
import { NewTaskDraftScopeContext, useNewTaskTypedScope } from "./useNewTaskPrompt";

const saved = vi.hoisted(() => ({ draft: undefined as unknown }));
vi.mock("./composerStashStore", () => ({
  createComposerStashStore: () => ({
    readRecovery: async () => undefined,
    stash: async (move: { location: unknown; beforeText: string }, draft: unknown) => {
      saved.draft = draft;
      return { ...move, draft: { text: "", caret: 0, files: [], context: [] }, revision: "1" };
    },
    restore: async (_id: string, move: object, draft: unknown) => ({
      ...move,
      draft,
      revision: "2",
    }),
    revise: async () => undefined,
  }),
}));

beforeEach(() => {
  vi.stubGlobal("indexedDB", {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  forgetTypedComposerText();
});

describe("a new-task composer's stash", () => {
  function composer(text: string) {
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <NewTaskDraftScopeContext.Provider value="scope-1">
        {children}
      </NewTaskDraftScopeContext.Provider>
    );
    return renderHook(
      () => {
        const [prompt, setPrompt] = useState(text);
        const scope = useNewTaskTypedScope();
        const binding = useNewTaskComposerStash({
          mode: "chat",
          host: undefined,
          projectId: undefined,
          prompt,
          textarea: createRef(),
          setPrompt: (next) => {
            // What the composer's input does when its value is replaced.
            composerTextReplaced(scope, next);
            setPrompt(next);
          },
          busy: false,
        });
        return { prompt, scope, binding, stash: useComposerStash(binding) };
      },
      { wrapper },
    ).result;
  }

  async function stashAndRestore(result: ReturnType<typeof composer>) {
    await act(async () => result.current.stash.move());
    expect(result.current.prompt).toBe("");
    expect(composerTextWasTyped(result.current.scope, "I prefer tabs")).toBe(false);
    const entry: SavedComposerDraft = {
      id: "saved-1",
      source: result.current.binding.target.location,
      savedAt: 1,
      draft: saved.draft as ComposerStashDraft,
    };
    await act(async () => result.current.stash.move(entry));
    expect(result.current.prompt).toBe("I prefer tabs");
  }

  it("keeps the claim of a draft the person typed through a stash and a restore", async () => {
    const result = composer("I prefer tabs");
    noteTypedComposerText(result.current.scope, "I prefer tabs");
    await stashAndRestore(result);
    expect(composerTextWasTyped(result.current.scope, result.current.prompt)).toBe(true);
  });

  it("gives a draft a button wrote no claim when it is restored", async () => {
    const result = composer("I prefer tabs");
    await stashAndRestore(result);
    expect(composerTextWasTyped(result.current.scope, result.current.prompt)).toBe(false);
  });
});
