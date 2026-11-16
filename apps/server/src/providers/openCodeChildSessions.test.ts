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

  it("lets a stop reach only a running child of the session that asks", () => {
    const children = new OpenCodeChildSessions();
    const isEitherRoot = (source: string) => source === "root" || source === "other-root";
    children.route(created("child", "root"), "child", isEitherRoot);
    children.route(created("grandchild", "child"), "grandchild", isEitherRoot);
    children.route(created("foreign", "other-root"), "foreign", isEitherRoot);
    expect(children.runsUnder("child", "root")).toBe(true);
    expect(children.runsUnder("grandchild", "root")).toBe(true);
    expect(children.runsUnder("foreign", "root")).toBe(false);
    expect(children.runsUnder("root", "root")).toBe(false);
    children.route(event("session.idle", { sessionID: "child" }), "child", isEitherRoot);
    expect(children.runsUnder("child", "root")).toBe(false);
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

  it("reports running once and completed once, and again when OpenCode resumes the child", () => {
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
    // A resumed child keeps its owner, so its requests still reach the parent.
    expect(children.route(busy, src(busy), isRoot)).toMatchObject({
      rootSource: "root",
      activity: { status: "running" },
    });
  });

  it("reports the model a child answered with, then its closing text and summed tokens when it finishes", () => {
    const children = new OpenCodeChildSessions();
    children.route(created("child", "root"), "child", isRoot);
    const assistant = (id: string, input: number, output: number) =>
      event("message.updated", {
        sessionID: "child",
        info: {
          id,
          sessionID: "child",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-haiku",
          tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
    expect(children.route(assistant("m1", 100, 20), "child", isRoot)).toMatchObject({
      activity: { status: "starting", modelId: "anthropic/claude-haiku" },
    });
    expect(children.route(assistant("m1", 120, 30), "child", isRoot)).not.toHaveProperty(
      "activity",
    );
    children.route(assistant("m2", 200, 40), "child", isRoot);
    children.route(
      event("message.part.updated", {
        sessionID: "child",
        part: { id: "p1", messageID: "m2", type: "text", text: "The build passes." },
      }),
      "child",
      isRoot,
    );
    expect(
      children.route(event("session.idle", { sessionID: "child" }), "child", isRoot),
    ).toMatchObject({
      activity: {
        status: "completed",
        finalSummary: "The build passes.",
        usage: { inputTokens: 320, outputTokens: 70 },
      },
    });
  });

  it("leaves model, closing text and usage unknown when a child reports none", () => {
    const children = new OpenCodeChildSessions();
    children.route(created("child", "root"), "child", isRoot);
    const route = children.route(event("session.idle", { sessionID: "child" }), "child", isRoot);
    if (route.kind !== "child") throw new Error("Expected the child's route");
    expect(route.activity).toMatchObject({ status: "completed" });
    expect(route.activity).not.toHaveProperty("modelId");
    expect(route.activity).not.toHaveProperty("finalSummary");
    expect(route.activity).not.toHaveProperty("usage");
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
