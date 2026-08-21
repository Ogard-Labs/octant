import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createComposerThreadDraftStore } from "./composerThreadDraftStore";
import { useComposerThreadDraft } from "./useComposerThreadDraft";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const chatThread = "00000000-0000-4000-8000-000000000811";
const otherChat = "00000000-0000-4000-8000-000000000812";
const workThread = "00000000-0000-4000-8000-000000000821";
const codeThread = "00000000-0000-4000-8000-000000000831";

describe("useComposerThreadDraft", () => {
  it("restores Chat text and caret after leaving the thread", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const { result, rerender } = renderHook(
      ({ threadId }) => useComposerThreadDraft({ mode: "chat", store, threadId }),
      { initialProps: { threadId: chatThread } },
    );

    act(() => result.current.setDraft("leave this here", 5));
    rerender({ threadId: otherChat });
    expect(result.current.text).toBe("");
    rerender({ threadId: chatThread });
    expect(result.current.text).toBe("leave this here");
    expect(result.current.caretIndex).toBe(5);
  });

  it("restores a Chat draft after the controller remounts, as a restart would", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const first = renderHook(() =>
      useComposerThreadDraft({ mode: "chat", store, threadId: chatThread }),
    );
    act(() => first.result.current.setDraft("survives restart", 3));
    first.unmount();

    const second = renderHook(() =>
      useComposerThreadDraft({ mode: "chat", store, threadId: chatThread }),
    );
    expect(second.result.current.text).toBe("survives restart");
    expect(second.result.current.caretIndex).toBe(3);
    second.unmount();
  });

  it("clears a Chat draft so sending cannot bring it back", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const { result } = renderHook(() =>
      useComposerThreadDraft({ mode: "chat", store, threadId: chatThread }),
    );
    act(() => result.current.setDraft("send this"));
    act(() => result.current.clear());
    expect(result.current.text).toBe("");
    expect(store.read("chat", chatThread)).toBeUndefined();
  });

  it("purges a Chat draft with its thread", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const { result } = renderHook(() =>
      useComposerThreadDraft({ mode: "chat", store, threadId: chatThread }),
    );
    act(() => result.current.setDraft("do not keep"));
    act(() => result.current.purge(chatThread));
    expect(result.current.text).toBe("");
    expect(store.read("chat", chatThread)).toBeUndefined();
  });

  it("restores a Work draft after leaving the thread and remounting", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const { result, rerender, unmount } = renderHook(
      ({ threadId }) => useComposerThreadDraft({ mode: "work", store, threadId }),
      { initialProps: { threadId: workThread } },
    );
    act(() => result.current.setDraft("quarterly notes", 9));
    rerender({ threadId: "00000000-0000-4000-8000-000000000822" });
    expect(result.current.text).toBe("");
    rerender({ threadId: workThread });
    expect(result.current.text).toBe("quarterly notes");
    expect(result.current.caretIndex).toBe(9);
    unmount();

    const remounted = renderHook(() =>
      useComposerThreadDraft({ mode: "work", store, threadId: workThread }),
    );
    expect(remounted.result.current.text).toBe("quarterly notes");
    remounted.unmount();
  });

  it("clears and purges a Work draft", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const { result } = renderHook(() =>
      useComposerThreadDraft({ mode: "work", store, threadId: workThread }),
    );
    act(() => result.current.setDraft("artifact body"));
    act(() => result.current.clear());
    expect(result.current.text).toBe("");
    act(() => result.current.setDraft("artifact body"));
    act(() => result.current.purge(workThread));
    expect(store.read("work", workThread)).toBeUndefined();
  });

  it("restores a Code draft after leaving the thread and remounting", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const { result, rerender, unmount } = renderHook(
      ({ threadId }) => useComposerThreadDraft({ mode: "code", store, threadId }),
      { initialProps: { threadId: codeThread } },
    );
    act(() => result.current.setDraft("fix the flaky test", 8));
    rerender({ threadId: "00000000-0000-4000-8000-000000000832" });
    expect(result.current.text).toBe("");
    rerender({ threadId: codeThread });
    expect(result.current.text).toBe("fix the flaky test");
    expect(result.current.caretIndex).toBe(8);
    unmount();

    const remounted = renderHook(() =>
      useComposerThreadDraft({ mode: "code", store, threadId: codeThread }),
    );
    expect(remounted.result.current.text).toBe("fix the flaky test");
    remounted.unmount();
  });

  it("clears and purges a Code draft", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const { result } = renderHook(() =>
      useComposerThreadDraft({ mode: "code", store, threadId: codeThread }),
    );
    act(() => result.current.setDraft("follow-up"));
    act(() => result.current.clear());
    expect(result.current.text).toBe("");
    act(() => result.current.setDraft("follow-up"));
    act(() => result.current.purge(codeThread));
    expect(store.read("code", codeThread)).toBeUndefined();
  });

  it("marks the abandoned thread when told its id after the current thread has changed", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const { result, rerender } = renderHook(
      ({ threadId }) => useComposerThreadDraft({ mode: "chat", store, threadId }),
      { initialProps: { threadId: chatThread } },
    );
    act(() => result.current.setDraft("keep this text"));
    rerender({ threadId: otherChat });
    act(() => result.current.markStagedDropped(chatThread));
    expect(store.read("chat", chatThread)?.stagedDropped).toBe(true);
    expect(store.read("chat", otherChat)).toBeUndefined();
  });

  it("keeps a failed send's text on the thread that sent it", () => {
    const store = createComposerThreadDraftStore(memoryStorage());
    const { result, rerender } = renderHook(
      ({ threadId }) => useComposerThreadDraft({ mode: "chat", store, threadId }),
      { initialProps: { threadId: chatThread } },
    );
    act(() => result.current.clearFor(chatThread));
    rerender({ threadId: otherChat });
    act(() => result.current.setDraft("newer draft"));
    act(() => result.current.writeFor(chatThread, "original prompt", 3));
    expect(result.current.text).toBe("newer draft");
    rerender({ threadId: chatThread });
    expect(result.current.text).toBe("original prompt");
    expect(result.current.caretIndex).toBe(3);
  });
});
