import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CodeDebugSessionId } from "@octant/contracts/code-debug";
import {
  decodeCodeFileId,
  decodeCodeFileMetadata,
  decodeCodeProjectFilePath,
} from "@octant/contracts/code";
import { decodeProjectId } from "@octant/contracts/projects";
import { CodeDebugWindowState, codeDebugThreadKey, fileBreakpoints } from "./codeDebugWindowState";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();
  failWrites = false;
  failRemoves = false;
  beforeSet: ((key: string, value: string) => void) | undefined;
  get length() {
    return this.#values.size;
  }
  clear() {
    this.#values.clear();
  }
  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    if (this.failWrites || this.failRemoves) throw new Error("Storage unavailable");
    this.#values.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("Storage unavailable");
    this.beforeSet?.(key, value);
    this.#values.set(key, value);
  }
  values() {
    return [...this.#values.values()];
  }
}
const scope = {
  origin: "http://127.0.0.1:13773",
  windowId: "40000000-0000-4000-8000-000000000001",
};
const key = codeDebugThreadKey(
  "20000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000001",
);
const path = decodeCodeProjectFilePath("src/main.js");
const observation = {
  projectId: decodeProjectId("50000000-0000-4000-8000-000000000001"),
  fileId: decodeCodeFileId("60000000-0000-4000-8000-000000000001"),
  metadata: decodeCodeFileMetadata({
    identity: { device: "1", inode: "2" },
    byteLength: 30,
    modifiedNanoseconds: "1",
    digest: "a".repeat(64),
  }),
  lineCount: 8,
  clean: true,
};
describe("breakpoint configuration survives only within its endpoint and window", () => {
  it("restores saved lines unresolved without restoring a debug session, then enables only an exact authorized file match", () => {
    const storage = new MemoryStorage();
    const first = new CodeDebugWindowState({ ...scope, storage });
    first.toggleBreakpoint(key, path, 3, observation);
    first.setCurrentFile(key, path);
    first.setStopped(key, { path, line: 3 });
    first.setSession(key, {
      sessionId: Schema.decodeUnknownSync(CodeDebugSessionId)(
        "80000000-0000-4000-8000-000000000001",
      ),
      name: "private runtime name",
    });
    const restored = new CodeDebugWindowState({ ...scope, storage });
    expect(restored.read(key).breakpoints.get(path)).toEqual([3]);
    expect(restored.read(key).currentFile).toBeUndefined();
    expect(restored.read(key).stopped).toBeUndefined();
    expect(restored.read(key).session).toBeUndefined();
    expect(fileBreakpoints(restored.read(key))).toEqual([]);
    restored.observeFile(key, path, observation);
    expect(fileBreakpoints(restored.read(key))).toEqual([{ path, breakpoints: [{ line: 3 }] }]);
    expect(storage.values().join("\n")).not.toMatch(
      /currentFile|stopped|sessionId|output|evaluate|private runtime name/,
    );
  });
  it("isolates colliding IDs by endpoint, window, thread and checkout", () => {
    const storage = new MemoryStorage();
    new CodeDebugWindowState({ ...scope, storage }).toggleBreakpoint(key, path, 3, observation);
    for (const other of [
      { ...scope, origin: "http://127.0.0.1:13774" },
      { ...scope, windowId: "40000000-0000-4000-8000-000000000002" },
    ])
      expect(new CodeDebugWindowState({ ...other, storage }).read(key).breakpoints.size).toBe(0);
    const store = new CodeDebugWindowState({ ...scope, storage });
    expect(
      store.read(
        codeDebugThreadKey(
          "20000000-0000-4000-8000-000000000002",
          "30000000-0000-4000-8000-000000000001",
        ),
      ).breakpoints.size,
    ).toBe(0);
    expect(
      store.read(
        codeDebugThreadKey(
          "20000000-0000-4000-8000-000000000001",
          "30000000-0000-4000-8000-000000000002",
        ),
      ).breakpoints.size,
    ).toBe(0);
    expect(store.read(key).breakpoints.get(path)).toEqual([3]);
  });
  it.each(["digest", "inode", "project"] as const)(
    "keeps a changed %s unresolved until explicit clean reacceptance",
    (change) => {
      const storage = new MemoryStorage();
      new CodeDebugWindowState({ ...scope, storage }).toggleBreakpoint(key, path, 3, observation);
      const store = new CodeDebugWindowState({ ...scope, storage });
      const changed = {
        ...observation,
        ...(change === "project"
          ? { projectId: decodeProjectId("50000000-0000-4000-8000-000000000002") }
          : {}),
        metadata: {
          ...observation.metadata,
          ...(change === "digest"
            ? {
                digest: decodeCodeFileMetadata({ ...observation.metadata, digest: "b".repeat(64) })
                  .digest,
              }
            : {}),
          identity: {
            ...observation.metadata.identity,
            ...(change === "inode" ? { inode: "3" } : {}),
          },
        },
      };
      store.observeFile(key, path, changed);
      expect(fileBreakpoints(store.read(key))).toEqual([]);
      expect(store.read(key).breakpointFiles?.get(path)?.reason).toBe(
        change === "project" ? "project-changed" : "changed",
      );
      expect(store.reacceptFile(key, path)).toBe(true);
      expect(fileBreakpoints(store.read(key))).toEqual([{ path, breakpoints: [{ line: 3 }] }]);
      const restarted = new CodeDebugWindowState({ ...scope, storage });
      expect(fileBreakpoints(restarted.read(key))).toEqual([]);
      restarted.observeFile(key, path, changed);
      expect(fileBreakpoints(restarted.read(key))).toHaveLength(1);
    },
  );
  it("keeps missing and out-of-range locations unresolved without moving them", () => {
    const storage = new MemoryStorage();
    const store = new CodeDebugWindowState({ ...scope, storage });
    store.toggleBreakpoint(key, path, 9, observation);
    expect(store.read(key).breakpointFiles?.get(path)?.reason).toBe("line-missing");
    expect(store.reacceptFile(key, path)).toBe(false);
    store.observeFile(key, path, undefined, "missing");
    expect(store.read(key).breakpoints.get(path)).toEqual([9]);
    expect(fileBreakpoints(store.read(key))).toEqual([]);
    expect(store.reacceptFile(key, path)).toBe(false);
    store.removeBreakpoint(key, path, 9);
    expect(new CodeDebugWindowState({ ...scope, storage }).read(key).breakpoints.size).toBe(0);
  });
  it("does not bind a new unsaved-buffer line to the previous saved file after restart", () => {
    const storage = new MemoryStorage();
    const store = new CodeDebugWindowState({ ...scope, storage });
    store.toggleBreakpoint(key, path, 3, observation);
    store.trackEditor(key, path, {}, () => true);
    store.observeFile(key, path, { ...observation, clean: false });
    expect(fileBreakpoints(store.read(key))).toEqual([]);
    store.observeFile(key, path, observation);
    expect(fileBreakpoints(store.read(key))).toEqual([]);
    expect(store.reacceptFile(key, path)).toBe(false);
    store.toggleBreakpoint(key, path, 5, { ...observation, clean: false });
    const restarted = new CodeDebugWindowState({ ...scope, storage });
    restarted.observeFile(key, path, observation);
    expect(restarted.read(key).breakpointFiles?.get(path)?.reason).toBe("unconfirmed");
    expect(fileBreakpoints(restarted.read(key))).toEqual([]);
    expect(restarted.reacceptFile(key, path)).toBe(true);
    expect(fileBreakpoints(restarted.read(key))).toEqual([
      { path, breakpoints: [{ line: 3 }, { line: 5 }] },
    ]);
  });
  it("purges the exact endpoint's thread across windows without resurrecting it or deleting another endpoint", () => {
    const storage = new MemoryStorage();
    const first = new CodeDebugWindowState({ ...scope, storage });
    const second = new CodeDebugWindowState({
      ...scope,
      storage,
      windowId: "40000000-0000-4000-8000-000000000002",
    });
    const otherHost = new CodeDebugWindowState({
      ...scope,
      storage,
      origin: "http://127.0.0.1:13774",
    });
    const otherThread = codeDebugThreadKey(
      "20000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000001",
    );
    first.toggleBreakpoint(key, path, 3, observation);
    second.toggleBreakpoint(key, path, 4, observation);
    otherHost.toggleBreakpoint(key, path, 5, observation);
    first.toggleBreakpoint(otherThread, path, 6, observation);
    first.purgeThread("20000000-0000-4000-8000-000000000001");
    second.reloadFromStorage();
    expect(first.read(key).breakpoints.size).toBe(0);
    expect(second.read(key).breakpoints.size).toBe(0);
    second.toggleBreakpoint(key, path, 7, observation);
    expect(second.read(key).breakpoints.size).toBe(0);
    expect(first.read(otherThread).breakpoints.get(path)).toEqual([6]);
    expect(otherHost.read(key).breakpoints.get(path)).toEqual([5]);
    const raw = storage.values().join("\n");
    expect(raw).not.toContain('"lines":[3]');
    expect(raw).not.toContain('"lines":[4]');
    expect(raw).not.toContain('"lines":[7]');
  });
  it("fences a purge racing another window's storage write", () => {
    const storage = new MemoryStorage();
    const store = new CodeDebugWindowState({ ...scope, storage });
    const other = new CodeDebugWindowState({
      ...scope,
      storage,
      windowId: "40000000-0000-4000-8000-000000000002",
    });
    storage.beforeSet = (name) => {
      if (!name.startsWith("octant.debug.breakpoints.v1:")) return;
      storage.beforeSet = undefined;
      other.purgeThread("20000000-0000-4000-8000-000000000001");
    };
    store.toggleBreakpoint(key, path, 3, observation);
    expect(store.read(key).breakpoints.size).toBe(0);
    expect(new CodeDebugWindowState({ ...scope, storage }).read(key).breakpoints.size).toBe(0);
    expect(storage.values().join("\n")).not.toContain("src/main.js");
  });
  it("reports failed removal truthfully and can retry purge", () => {
    const storage = new MemoryStorage();
    const store = new CodeDebugWindowState({ ...scope, storage });
    store.toggleBreakpoint(key, path, 3, observation);
    storage.failWrites = true;
    store.removeBreakpoint(key, path, 3);
    expect(store.read(key).breakpoints.size).toBe(0);
    expect(store.read(key).persistenceWarning).toMatch(/could not be saved/);
    storage.failWrites = false;
    expect(new CodeDebugWindowState({ ...scope, storage }).read(key).breakpoints.get(path)).toEqual(
      [3],
    );
    store.purgeThread("20000000-0000-4000-8000-000000000001");
    expect(new CodeDebugWindowState({ ...scope, storage }).read(key).breakpoints.size).toBe(0);
  });
  it("does not overwrite corrupt configuration or persist extra debug data", () => {
    const storage = new MemoryStorage();
    new CodeDebugWindowState({ ...scope, storage }).toggleBreakpoint(key, path, 3, observation);
    const name = storage.key(0);
    if (name === null) throw new Error("Saved key missing");
    const raw = JSON.stringify({ version: 1, files: [], output: "private output" });
    storage.setItem(name, raw);
    const store = new CodeDebugWindowState({ ...scope, storage });
    expect(store.read(key).persistenceWarning).toMatch(/could not be saved/);
    store.toggleBreakpoint(key, path, 5, observation);
    expect(storage.getItem(name)).toBe(raw);
    expect(store.read(key).persistenceWarning).toBeDefined();
  });
  it("reports removal uncertainty even when the purge marker was written", () => {
    const storage = new MemoryStorage();
    const store = new CodeDebugWindowState({ ...scope, storage });
    store.toggleBreakpoint(key, path, 3, observation);
    storage.failRemoves = true;
    store.purgeThread("20000000-0000-4000-8000-000000000001");
    expect(store.read(key).persistenceWarning).toMatch(/could not be removed/);
    expect(storage.values().join("\n")).toContain("src/main.js");
    expect(new CodeDebugWindowState({ ...scope, storage }).read(key).breakpoints.size).toBe(0);
    storage.failRemoves = false;
    store.purgeThread("20000000-0000-4000-8000-000000000001");
    expect(storage.values().join("\n")).not.toContain("src/main.js");
  });
});
