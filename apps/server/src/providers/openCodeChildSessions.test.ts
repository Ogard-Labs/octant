import { describe, expect, it } from "vitest";
import { OpenCodeChildSessions } from "./openCodeChildSessions";
import type { OpenCodeEvent } from "./openCodeEventMapper";

const created = (sessionID: string, parentID?: string, title = "Check the build"): OpenCodeEvent =>
  ({
    type: "session.created",
    properties: { sessionID, info: { id: sessionID, title, ...(parentID ? { parentID } : {}) } },
  }) as unknown as OpenCodeEvent;

const event = (type: string, properties: Record<string, unknown>): OpenCodeEvent =>
  ({ type, properties }) as unknown as OpenCodeEvent;

const src = (e: OpenCodeEvent): string => String((e.properties as { sessionID: string }).sessionID);
const isRoot = (source: string) => source === "root";

describe("OpenCodeChildSessions", () => {
  it("follows a session that names the owning session as its parent", () => {
    const children = new OpenCodeChildSessions();
    const route = children.route(created("child", "root"), src(created("child", "root")), isRoot);
    expect(route).toMatchObject({
      kind: "child",
      rootSource: "root",
      childSource: "child",
      activity: { childAgentId: "child", status: "starting", task: "Check the build" },
    });
  });

  it("does not claim a session whose parent is not one it started", () => {
    const children = new OpenCodeChildSessions();
    expect(
      children.route(created("stray", "elsewhere"), src(created("stray", "elsewhere")), isRoot),
    ).toEqual({ kind: "none" });
    expect(children.route(created("plain"), src(created("plain")), isRoot)).toEqual({
      kind: "none",
    });
    expect(
      children.route(
        event("session.idle", { sessionID: "stray" }),
        src(event("session.idle", { sessionID: "stray" })),
        isRoot,
      ),
    ).toEqual({
      kind: "none",
    });
  });

  it("follows a child of a child back to the session that owns it", () => {
    const children = new OpenCodeChildSessions();
    children.route(created("child", "root"), src(created("child", "root")), isRoot);
    const route = children.route(
      created("grandchild", "child"),
      src(created("grandchild", "child")),
      isRoot,
    );
    expect(route).toMatchObject({
      rootSource: "root",
      activity: { childAgentId: "grandchild", parentChildAgentId: "child" },
    });
  });

  it("reports running once and completed once, then stays finished", () => {
    const children = new OpenCodeChildSessions();
    children.route(created("child", "root"), src(created("child", "root")), isRoot);
    const busy = event("session.status", { sessionID: "child", status: { type: "busy" } });
    expect(children.route(busy, src(busy), isRoot)).toMatchObject({
      activity: { status: "running" },
    });
    expect(children.route(busy, src(busy), isRoot)).not.toHaveProperty("activity");
    const idle = event("session.idle", { sessionID: "child" });
    expect(children.route(idle, src(idle), isRoot)).toMatchObject({
      activity: { status: "completed" },
    });
    expect(children.route(busy, src(busy), isRoot)).not.toHaveProperty("activity");
  });

  it("reports a child that errored as failed", () => {
    const children = new OpenCodeChildSessions();
    children.route(created("child", "root"), src(created("child", "root")), isRoot);
    expect(
      children.route(
        event("session.error", { sessionID: "child" }),
        src(event("session.error", { sessionID: "child" })),
        isRoot,
      ),
    ).toMatchObject({
      activity: { status: "failed" },
    });
  });

  it("hands a child's permission request back to the owning session", () => {
    const children = new OpenCodeChildSessions();
    children.route(created("child", "root"), src(created("child", "root")), isRoot);
    const asked = event("permission.asked", { sessionID: "child", id: "p1", permission: "bash" });
    expect(children.route(asked, src(asked), isRoot)).toMatchObject({
      rootSource: "root",
      childSource: "child",
      forward: asked,
    });
  });

  it("keeps a child's own text and tool output out of the owning session", () => {
    const children = new OpenCodeChildSessions();
    children.route(created("child", "root"), src(created("child", "root")), isRoot);
    const text = event("session.next.text.delta", { sessionID: "child", delta: "hello" });
    const route = children.route(text, src(text), isRoot);
    expect(route).toMatchObject({ kind: "child" });
    expect(route).not.toHaveProperty("forward");
    expect(route).not.toHaveProperty("activity");
  });

  it("forgets the children of a session that ended", () => {
    const children = new OpenCodeChildSessions();
    children.route(created("child", "root"), src(created("child", "root")), isRoot);
    children.forget("root");
    expect(
      children.route(
        event("session.idle", { sessionID: "child" }),
        src(event("session.idle", { sessionID: "child" })),
        isRoot,
      ),
    ).toEqual({
      kind: "none",
    });
  });
});
