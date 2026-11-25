import { renderHook } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useNewTaskComposerStash } from "./useNewTaskComposerStash";
import { NewTaskDraftScopeContext, useNewTaskTypedScope } from "./useNewTaskPrompt";

describe("a new-task composer's stash", () => {
  it("carries the scope its prompt notes typing under, so a stash and a restore keep the claim", () => {
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <NewTaskDraftScopeContext.Provider value="scope-1">
        {children}
      </NewTaskDraftScopeContext.Provider>
    );
    const { result } = renderHook(
      () => ({
        stash: useNewTaskComposerStash({
          mode: "chat",
          host: undefined,
          projectId: undefined,
          prompt: "I prefer tabs",
          textarea: createRef(),
          setPrompt: () => undefined,
          busy: false,
        }),
        scope: useNewTaskTypedScope(),
      }),
      { wrapper },
    );

    expect(result.current.stash.typedScope).toBe("new-task:scope-1");
    expect(result.current.stash.typedScope).toBe(result.current.scope);
  });
});
