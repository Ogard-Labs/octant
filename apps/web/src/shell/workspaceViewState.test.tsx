import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceViewStore } from "./workspaceViewState";
afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});
describe("kept workspace presentation", () => {
  it("restores only bounded references for the same endpoint, window and exact content version", () => {
    vi.useFakeTimers();
    const first = createWorkspaceViewStore("host-a:window-a");
    first.write("project-root:editor:file-a:digest-a", {
      kind: "editor",
      lineNumber: 25,
      column: 3,
      scrollTop: 400,
      scrollLeft: 0,
    });
    first.write("project-root:review:digest-b", {
      kind: "review",
      path: "src/second.ts",
      scrollTop: 80,
    });
    first.flush();
    const restored = createWorkspaceViewStore("host-a:window-a");
    expect(restored.read("project-root:editor:file-a:digest-a")).toMatchObject({
      kind: "editor",
      lineNumber: 25,
      scrollTop: 400,
    });
    expect(restored.read("project-root:editor:file-a:digest-new")).toBeUndefined();
    expect(
      createWorkspaceViewStore("host-a:window-b").read("project-root:review:digest-b"),
    ).toBeUndefined();
    expect(
      createWorkspaceViewStore("host-b:window-a").read("project-root:review:digest-b"),
    ).toBeUndefined();
  });
  it("bounds retained views and refuses impossible scroll positions", () => {
    vi.useFakeTimers();
    const store = createWorkspaceViewStore("bounded");
    for (let n = 0; n < 70; n++) store.write(`view-${n}`, { kind: "review", scrollTop: n });
    store.write("invalid", { kind: "review", scrollTop: Number.POSITIVE_INFINITY });
    store.flush();
    const restored = createWorkspaceViewStore("bounded");
    expect(restored.read("view-0")).toBeUndefined();
    expect(restored.read("view-69")).toMatchObject({ scrollTop: 69 });
    expect(restored.read("invalid")).toBeUndefined();
  });
});
