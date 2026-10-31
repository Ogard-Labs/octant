import { describe, expect, it } from "vitest";
import {
  THREAD_MOVE_REFUSALS,
  decideThreadMove,
  folderContains,
  folderRelativeTo,
} from "./threadProjectMovePolicy";

const idle = { lifecycle: "active", executing: false, awaitingInput: false } as const;
const source = { id: "project-a", mode: "work", folder: "/Users/me/Docs/Reports" } as const;
const destination = {
  id: "project-b",
  mode: "work",
  lifecycle: "active",
  folder: "/Users/me/Docs/Reports",
} as const;

describe("folderContains", () => {
  it("accepts the same folder and a folder inside it, and nothing that only shares a prefix", () => {
    expect(folderContains("/a/b", "/a/b")).toBe(true);
    expect(folderContains("/a/b", "/a/b/c/d")).toBe(true);
    expect(folderContains("/a/b/", "/a/b/c")).toBe(true);
    expect(folderContains("/", "/a/b")).toBe(true);
    expect(folderContains("/a/b", "/a/bc")).toBe(false);
    expect(folderContains("/a/b/c", "/a/b")).toBe(false);
  });
});

describe("folderRelativeTo", () => {
  it("names the inner folder relative to the outer one, or a dot for the same folder", () => {
    expect(folderRelativeTo("/a/b", "/a/b")).toBe(".");
    expect(folderRelativeTo("/a/b", "/a/b/c/d")).toBe("c/d");
    expect(folderRelativeTo("/", "/a")).toBe("a");
    expect(folderRelativeTo("/a/b", "/a")).toBeUndefined();
  });
});

describe("decideThreadMove", () => {
  it("allows a move into another Project of the same mode bound to the same folder", () => {
    expect(decideThreadMove({ thread: idle, source, destination })).toEqual({ status: "allowed" });
  });

  it("allows a move into a Project whose folder contains the thread's folder", () => {
    expect(
      decideThreadMove({
        thread: idle,
        source,
        destination: { ...destination, folder: "/Users/me/Docs" },
      }),
    ).toEqual({ status: "allowed" });
  });

  it("refuses a Project whose folder is elsewhere or only inside the thread's folder", () => {
    for (const folder of ["/Users/me/Other", "/Users/me/Docs/Reports/2026", "/Users/me/Docs/Rep"]) {
      expect(
        decideThreadMove({ thread: idle, source, destination: { ...destination, folder } }),
      ).toEqual({ status: "refused", reason: "different-folder" });
    }
  });

  it("refuses a Project of another mode, an archived Project, and the thread's own Project", () => {
    expect(
      decideThreadMove({ thread: idle, source, destination: { ...destination, mode: "code" } }),
    ).toEqual({ status: "refused", reason: "different-mode" });
    expect(
      decideThreadMove({
        thread: idle,
        source,
        destination: { ...destination, lifecycle: "archived" },
      }),
    ).toEqual({ status: "refused", reason: "destination-unavailable" });
    expect(
      decideThreadMove({ thread: idle, source, destination: { ...destination, id: source.id } }),
    ).toEqual({ status: "refused", reason: "same-project" });
  });

  it("refuses while the thread is archived, running a turn, or waiting on the person", () => {
    expect(
      decideThreadMove({ thread: { ...idle, lifecycle: "archived" }, source, destination }),
    ).toEqual({ status: "refused", reason: "archived-thread" });
    expect(
      decideThreadMove({ thread: { ...idle, lifecycle: "waiting" }, source, destination }),
    ).toEqual({ status: "allowed" });
    expect(decideThreadMove({ thread: { ...idle, executing: true }, source, destination })).toEqual(
      { status: "refused", reason: "running" },
    );
    expect(
      decideThreadMove({ thread: { ...idle, awaitingInput: true }, source, destination }),
    ).toEqual({ status: "refused", reason: "awaiting-input" });
  });

  it("gives every refusal a plain sentence", () => {
    for (const sentence of Object.values(THREAD_MOVE_REFUSALS)) {
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence.endsWith(".")).toBe(true);
    }
  });
});
