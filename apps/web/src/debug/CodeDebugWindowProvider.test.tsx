import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeCodeFileId,
  decodeCodeFileMetadata,
  decodeCodeProjectFilePath,
} from "@octant/contracts/code";
import { decodeProjectId } from "@octant/contracts/projects";
import { CodeDebugWindowProvider, useCodeDebugWindowStore } from "./CodeDebugWindowProvider";
import { codeDebugThreadKey, fileBreakpoints } from "./codeDebugWindowState";
const thread = "20000000-0000-4000-8000-000000000001";
const otherThread = "20000000-0000-4000-8000-000000000002";
const checkout = "30000000-0000-4000-8000-000000000001";
const key = codeDebugThreadKey(thread, checkout);
const path = decodeCodeProjectFilePath("src/main.js");
const observation = {
  projectId: decodeProjectId("50000000-0000-4000-8000-000000000001"),
  fileId: decodeCodeFileId("60000000-0000-4000-8000-000000000001"),
  metadata: decodeCodeFileMetadata({
    identity: { device: "1", inode: "2" },
    digest: "a".repeat(64),
    byteLength: 8,
    modifiedNanoseconds: "1",
  }),
  lineCount: 4,
  clean: true,
};
const origin = "http://localhost:13773";
afterEach(() => localStorage.clear());
describe("scoped window breakpoint storage events", () => {
  it("preserves another window and unrelated thread's verified active set, but applies exact origin-wide purge", () => {
    const a = renderHook(() => useCodeDebugWindowStore(), {
      wrapper: ({ children }) => (
        <CodeDebugWindowProvider origin={origin} windowId="window-a">
          {children}
        </CodeDebugWindowProvider>
      ),
    });
    const b = renderHook(() => useCodeDebugWindowStore(), {
      wrapper: ({ children }) => (
        <CodeDebugWindowProvider origin={origin} windowId="window-b">
          {children}
        </CodeDebugWindowProvider>
      ),
    });
    act(() => {
      a.result.current.toggleBreakpoint(key, path, 3, observation);
      b.result.current.toggleBreakpoint(key, path, 2, observation);
    });
    const active = a.result.current.read(key);
    const change = (name: string) =>
      act(() => {
        globalThis.dispatchEvent(
          new StorageEvent("storage", { key: name, newValue: localStorage.getItem(name) }),
        );
      });
    change("octant.debug.breakpoints.v1:" + JSON.stringify([origin, "window-b", thread, checkout]));
    expect(a.result.current.read(key)).toBe(active);
    expect(fileBreakpoints(a.result.current.read(key))).toEqual([
      { path, breakpoints: [{ line: 3 }] },
    ]);
    const otherKey = codeDebugThreadKey(otherThread, checkout);
    act(() => a.result.current.toggleBreakpoint(otherKey, path, 4, observation));
    change(
      "octant.debug.breakpoints.v1:" + JSON.stringify([origin, "window-a", otherThread, checkout]),
    );
    expect(a.result.current.read(key)).toBe(active);
    act(() => {
      b.result.current.purgeThread(thread);
    });
    change("octant.debug.breakpoints.purged.v1:" + JSON.stringify([origin, thread]));
    expect(fileBreakpoints(a.result.current.read(key))).toEqual([]);
    expect(a.result.current.read(key).breakpoints.size).toBe(0);
    expect(a.result.current.read(otherKey).breakpoints.get(path)).toEqual([4]);
  });
});
