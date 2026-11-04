import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCodeFileOpenResultEnvelope } from "@octant/contracts/code-operations";
import {
  decodeCodeCheckoutId,
  decodeCodeFileId,
  decodeCodeFileMetadata,
  decodeCodeProjectFilePath,
  decodeCodeThreadId,
} from "@octant/contracts/code";
import { decodeProjectId } from "@octant/contracts/projects";
import type { CodeClient } from "@octant/client-runtime/code-client";
import { CodeDebugWindowState, codeDebugThreadKey } from "./codeDebugWindowState";
import { useCodeBreakpointValidation } from "./useCodeBreakpointValidation";
const threadId = decodeCodeThreadId("20000000-0000-4000-8000-000000000001");
const checkoutId = decodeCodeCheckoutId("30000000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("50000000-0000-4000-8000-000000000001");
const fileId = decodeCodeFileId("60000000-0000-4000-8000-000000000001");
const path = decodeCodeProjectFilePath("src/main.js");
const key = codeDebugThreadKey(threadId, checkoutId);
const metadata = decodeCodeFileMetadata({
  identity: { device: "1", inode: "2" },
  byteLength: 8,
  modifiedNanoseconds: "1",
  digest: "a".repeat(64),
});
const changed = decodeCodeFileMetadata({ ...metadata, digest: "b".repeat(64) });
const bytes = () => new TextEncoder().encode("a\nb\nc\nd\n");
function opened(meta = metadata) {
  return decodeCodeFileOpenResultEnvelope({
    kind: "code-file-open-result",
    result: {
      status: "editable",
      fileId,
      metadata: meta,
      content: {
        contentId: "70000000-0000-4000-8000-000000000001",
        digest: meta.digest,
        byteLength: 8,
      },
    },
  }).result;
}
function setup() {
  const storage = new Map<string, string>();
  const port = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  };
  const scope = { origin: "http://localhost:13773", windowId: "window-1", storage: port };
  const original = new CodeDebugWindowState(scope);
  original.toggleBreakpoint(key, path, 3, {
    projectId,
    fileId,
    metadata,
    lineCount: 4,
    clean: true,
  });
  const store = new CodeDebugWindowState(scope);
  let release: (value: Uint8Array) => void = () => undefined;
  const held = new Promise<Uint8Array>((resolve) => {
    release = resolve;
  });
  const client: Pick<CodeClient, "openFile" | "content"> = {
    openFile: vi.fn(async () => opened()),
    content: vi.fn(() => held),
  };
  return { store, client, release };
}
afterEach(() => vi.restoreAllMocks());
describe("authorized saved-file validation lifetime", () => {
  it("refuses a held read after absolute elapsed deadline before the timeout callback runs", async () => {
    const f = setup();
    const base = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(base);
    renderHook(() =>
      useCodeBreakpointValidation({
        client: f.client,
        store: f.store,
        threadKey: key,
        threadId,
        checkoutId,
        projectId,
        enabled: true,
      }),
    );
    await waitFor(() => expect(f.client.content).toHaveBeenCalledTimes(1));
    clock.mockReturnValue(base + 15001);
    await act(async () => {
      f.release(bytes());
    });
    expect(f.store.read(key).breakpointFiles?.get(path)?.status).toBe("unresolved");
    expect(f.store.read(key).breakpointFiles?.get(path)?.reason).toBe("unavailable");
  });
  it("does not let an older Refresh read overwrite a newer explicitly accepted file", async () => {
    const f = setup();
    const view = renderHook(() =>
      useCodeBreakpointValidation({
        client: f.client,
        store: f.store,
        threadKey: key,
        threadId,
        checkoutId,
        projectId,
        enabled: true,
      }),
    );
    await waitFor(() => expect(f.client.content).toHaveBeenCalledTimes(1));
    vi.mocked(f.client.openFile).mockResolvedValue(opened(changed));
    vi.mocked(f.client.content).mockResolvedValue(bytes());
    await act(async () => {
      expect(await view.result.current.reaccept(path)).toBe(true);
    });
    expect(f.store.read(key).breakpointFiles?.get(path)?.binding?.metadata.digest).toBe(
      changed.digest,
    );
    await act(async () => {
      f.release(bytes());
    });
    expect(f.store.read(key).breakpointFiles?.get(path)?.binding?.metadata.digest).toBe(
      changed.digest,
    );
    expect(f.store.read(key).breakpointFiles?.get(path)?.status).toBe("verified");
  });
  it("refuses late results after a thread switch or exact purge without restoring a session", async () => {
    const f = setup();
    const nextThread = decodeCodeThreadId("20000000-0000-4000-8000-000000000002");
    const view = renderHook(
      ({ thread }) =>
        useCodeBreakpointValidation({
          client: f.client,
          store: f.store,
          threadKey: codeDebugThreadKey(thread, checkoutId),
          threadId: thread,
          checkoutId,
          projectId,
          enabled: true,
        }),
      { initialProps: { thread: threadId } },
    );
    await waitFor(() => expect(f.client.content).toHaveBeenCalledTimes(1));
    view.rerender({ thread: nextThread });
    act(() => {
      f.store.purgeThread(threadId);
    });
    await act(async () => {
      f.release(bytes());
    });
    expect(f.store.read(key).breakpoints.size).toBe(0);
    expect(f.store.read(codeDebugThreadKey(nextThread, checkoutId)).breakpoints.size).toBe(0);
    expect(f.store.read(key).session).toBeUndefined();
  });
  it("invalidates a previous match when its currently authorized Project reader is unavailable", async () => {
    const f = setup();
    vi.mocked(f.client.content).mockResolvedValue(bytes());
    const view = renderHook(
      ({ enabled }) =>
        useCodeBreakpointValidation({
          client: f.client,
          store: f.store,
          threadKey: key,
          threadId,
          checkoutId,
          projectId,
          enabled,
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() =>
      expect(f.store.read(key).breakpointFiles?.get(path)?.status).toBe("verified"),
    );
    view.rerender({ enabled: false });
    expect(f.store.read(key).breakpointFiles?.get(path)?.status).toBe("unresolved");
    expect(f.client.openFile).toHaveBeenCalledTimes(1);
  });
});
