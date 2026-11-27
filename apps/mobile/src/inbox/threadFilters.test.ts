import type { MobileInboxRow } from "@octant/client-runtime";
import { describe, expect, it } from "vitest";
import { filterThreads, NO_THREAD_FILTER } from "./threadFilters";

const row = (threadId: string, fields: Partial<MobileInboxRow>): MobileInboxRow => ({
  hostId: "studio",
  mode: "chat",
  threadId,
  title: threadId,
  status: "active",
  freshness: "2026-11-25T08:00:00.000Z",
  ...fields,
});
const rows = [
  row("chat", { mode: "chat" }),
  row("work", { mode: "work", projectId: "notes" }),
  row("code", { mode: "code", projectId: "octant" }),
  row("code on laptop", { mode: "code", projectId: "octant", hostId: "laptop" }),
];
const ids = (filter: Partial<typeof NO_THREAD_FILTER>) =>
  filterThreads(rows, { ...NO_THREAD_FILTER, ...filter }).map((item) => item.threadId);

describe("Threads", () => {
  it("lists Chat, Work and Code threads from every computer", () => {
    expect(ids({})).toEqual(["chat", "work", "code", "code on laptop"]);
  });

  it("narrows to Code", () => {
    expect(ids({ mode: "code" })).toEqual(["code", "code on laptop"]);
  });

  it("narrows to one computer and one Project together", () => {
    expect(ids({ hostId: "laptop", project: { hostId: "laptop", projectId: "octant" } })).toEqual([
      "code on laptop",
    ]);
  });

  it("keeps a Project on one computer apart from the same id on another", () => {
    expect(ids({ project: { hostId: "studio", projectId: "octant" } })).toEqual(["code"]);
  });
});
