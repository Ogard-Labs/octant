import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OctantHostBridge } from "../shell/hostBridge";
import type * as Guard from "./filesCloseGuard";
import type * as Hook from "./useDesktopFilesClose";

type FilesCloseRequest = { requestId: number; kind: "check" | "release" };

let guard: typeof Guard;
let useDesktopFilesClose: typeof Hook.useDesktopFilesClose;

// The registry is module state the hook reaches through its own import; a
// single reset keeps the test and the hook on one copy.
beforeEach(async () => {
  vi.resetModules();
  guard = await import("./filesCloseGuard");
  ({ useDesktopFilesClose } = await import("./useDesktopFilesClose"));
  document.body.inert = false;
});

function bridge() {
  let listener: ((request: FilesCloseRequest) => void) | undefined;
  const replies: Array<{ requestId: number; answer: string }> = [];
  const host = {
    subscribeFilesCloseRequest: (receive: (request: FilesCloseRequest) => void) => {
      listener = receive;
      return () => {
        listener = undefined;
      };
    },
    replyFilesClose: vi.fn(
      async (requestId: number, answer: "checking" | "prompting" | "allow" | "cancel") => {
        replies.push({ requestId, answer });
        return true;
      },
    ),
  };
  return {
    host: host as unknown as OctantHostBridge,
    send: (request: FilesCloseRequest) => listener?.(request),
    replies,
  };
}

function dirtyFile() {
  const state = { dirty: true };
  guard.registerFilesCloseEntry({
    scope: guard.filesCloseScope(undefined, "thread"),
    key: "octant-code://checkout/file",
    name: "notes.md",
    isDirty: () => state.dirty,
    save: async () => {
      state.dirty = false;
      return true;
    },
    discard: () => {
      state.dirty = false;
    },
  });
}

async function prompt(): Promise<Guard.FilesClosePrompt> {
  await waitFor(() => expect(guard.filesClosePromptSnapshot()).toBeDefined());
  return guard.filesClosePromptSnapshot() as Guard.FilesClosePrompt;
}

describe("useDesktopFilesClose", () => {
  it("acknowledges a check, locks the document before allowing, and unlocks on release", async () => {
    const { host, send, replies } = bridge();
    dirtyFile();
    renderHook(() => useDesktopFilesClose(host));
    act(() => send({ requestId: 7, kind: "check" }));
    await waitFor(() => expect(replies).toContainEqual({ requestId: 7, answer: "checking" }));
    const question = await prompt();
    expect(document.body.inert).toBe(false);
    await act(async () => question.answer("save"));
    await waitFor(() => expect(replies).toContainEqual({ requestId: 7, answer: "allow" }));
    expect(document.body.inert).toBe(true);
    act(() => send({ requestId: 7, kind: "release" }));
    expect(document.body.inert).toBe(false);
  });

  it("announces prompting only when its question actually reaches the screen", async () => {
    const { host, send, replies } = bridge();
    dirtyFile();
    renderHook(() => useDesktopFilesClose(host));
    act(() => send({ requestId: 7, kind: "check" }));
    const question = await prompt();
    // The acknowledgement went first; the prompt announcement follows it
    // once the question is visible — the desktop raises the window then.
    await waitFor(() => expect(replies).toContainEqual({ requestId: 7, answer: "prompting" }));
    const order = replies.map((reply) => reply.answer);
    expect(order.indexOf("checking")).toBe(0);
    expect(order.indexOf("prompting")).toBeGreaterThan(order.indexOf("checking"));
    await act(async () => question.answer("discard"));
    await waitFor(() => expect(replies).toContainEqual({ requestId: 7, answer: "allow" }));
  });

  it("never announces prompting when the window has nothing to ask", async () => {
    const { host, send, replies } = bridge();
    renderHook(() => useDesktopFilesClose(host));
    act(() => send({ requestId: 3, kind: "check" }));
    await waitFor(() => expect(replies).toContainEqual({ requestId: 3, answer: "allow" }));
    expect(replies.some((reply) => reply.answer === "prompting")).toBe(false);
  });

  it("answers a refused prompt with cancel and never locks the document", async () => {
    const { host, send, replies } = bridge();
    dirtyFile();
    renderHook(() => useDesktopFilesClose(host));
    act(() => send({ requestId: 2, kind: "check" }));
    const question = await prompt();
    await act(async () => question.answer("cancel"));
    await waitFor(() => expect(replies).toContainEqual({ requestId: 2, answer: "cancel" }));
    expect(replies.some((reply) => reply.answer === "allow")).toBe(false);
    expect(document.body.inert).toBe(false);
  });

  it("answers a second check while one is active with cancel", async () => {
    const { host, send, replies } = bridge();
    dirtyFile();
    renderHook(() => useDesktopFilesClose(host));
    act(() => send({ requestId: 1, kind: "check" }));
    await prompt();
    act(() => send({ requestId: 2, kind: "check" }));
    await waitFor(() => expect(replies).toContainEqual({ requestId: 2, answer: "cancel" }));
    // The first request still owns the open prompt.
    expect(guard.filesClosePromptSnapshot()?.name).toBe("notes.md");
  });

  it("answers a released prompt cancel so nothing can allow or freeze afterward", async () => {
    const { host, send, replies } = bridge();
    dirtyFile();
    renderHook(() => useDesktopFilesClose(host));
    act(() => send({ requestId: 5, kind: "check" }));
    await prompt();
    act(() => send({ requestId: 5, kind: "release" }));
    await waitFor(() => expect(guard.filesClosePromptSnapshot()).toBeUndefined());
    expect(document.body.inert).toBe(false);
    // A release for a different request id does not touch the next check.
    act(() => send({ requestId: 9, kind: "release" }));
    act(() => send({ requestId: 9, kind: "check" }));
    const question = await prompt();
    await act(async () => question.answer("discard"));
    await waitFor(() => expect(replies).toContainEqual({ requestId: 9, answer: "allow" }));
    expect(document.body.inert).toBe(true);
  });
});
