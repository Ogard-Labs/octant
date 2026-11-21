import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
} from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  acpListedSessions,
  acpReplayCollector,
  acpReplayedMessages,
  makeAcpNativeSessions,
  readAcpSessionPages,
  type AcpListedSession,
} from "./acpNativeSessions";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000b01");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000b02");
const modelId = decodeProviderModelId("gemini-3.8-flash");

function sessions(
  listed: ReadonlyArray<AcpListedSession> | "unsupported",
  held: string[] = [],
  truncated = false,
) {
  return makeAcpNativeSessions({
    instanceId,
    driverKind: "antigravity",
    displayName: "Google Antigravity",
    heldSessions: () => new Set(held),
    listSessions: async () => (listed === "unsupported" ? listed : { sessions: listed, truncated }),
  });
}

describe("an ACP agent's own sessions", () => {
  it("lists the folder's sessions newest first, leaving out held ones and other folders", async () => {
    const native = sessions(
      [
        { sessionId: "old", cwd: "/work/app", title: "Old", updatedAt: "2026-11-01T00:00:00Z" },
        { sessionId: "new", cwd: "/work/app", title: " New ", updatedAt: "2026-11-19T00:00:00Z" },
        { sessionId: "held", cwd: "/work/app", updatedAt: "2026-11-20T00:00:00Z" },
        { sessionId: "elsewhere", cwd: "/work/other", updatedAt: "2026-11-20T00:00:00Z" },
      ],
      ["held"],
    );
    const listed = await Effect.runPromise(native.list({ instanceId, projectRoot: "/work/app" }));
    expect(listed.map((session) => [session.nativeSessionId, session.title])).toEqual([
      ["new", "New"],
      ["old", "Old"],
    ]);
  });

  it("adopts a listed session once, and refuses one another thread holds or one not listed", async () => {
    const native = sessions([{ sessionId: "s1", cwd: "/work/app" }]);
    const adopt = (nativeSessionId: string) =>
      Effect.runPromise(
        Effect.either(
          native.adopt({
            instanceId,
            projectRoot: "/work/app",
            mode: "code",
            sessionId,
            nativeSessionId,
            modelId,
          }),
        ),
      );
    const first = await adopt("s1");
    expect(first).toMatchObject({
      _tag: "Right",
      right: { driverKind: "antigravity", value: "s1" },
    });
    expect(await adopt("s1")).toMatchObject({ _tag: "Left", left: { category: "unavailable" } });
    expect(await adopt("missing")).toMatchObject({
      _tag: "Left",
      left: { category: "stale-resume" },
    });
  });

  it("says a session it could not reach is past what it reads, rather than gone, when the list stopped at a bound", async () => {
    const native = sessions([{ sessionId: "s1", cwd: "/work/app" }], [], true);
    const result = await Effect.runPromise(
      Effect.either(
        native.adopt({
          instanceId,
          projectRoot: "/work/app",
          mode: "code",
          sessionId,
          nativeSessionId: "beyond",
          modelId,
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        category: "unavailable",
        message:
          "That session is past the sessions Octant can read; open it in Google Antigravity instead.",
      },
    });
  });

  it("says plainly when the agent does not list its sessions", async () => {
    const result = await Effect.runPromise(
      Effect.either(sessions("unsupported").list({ instanceId, projectRoot: "/work/app" })),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { category: "unsupported" } });
  });

  it("reads the session/list reply and skips entries without an id", () => {
    expect(
      acpListedSessions({
        sessions: [
          { sessionId: "a", title: "A", cwd: "/x" },
          { title: "no id" },
          { sessionId: "" },
        ],
        nextCursor: "c",
      }),
    ).toEqual([{ sessionId: "a", title: "A", cwd: "/x" }]);
    expect(acpListedSessions({})).toBeUndefined();
  });

  it("offers and adopts a session the agent lists only on a later page", async () => {
    const pages: Record<string, unknown> = {
      first: { sessions: [{ sessionId: "held", cwd: "/work/app" }], nextCursor: "page-2" },
      "page-2": { sessions: [{ sessionId: "later", cwd: "/work/app" }] },
    };
    const requested: Array<string | undefined> = [];
    const native = makeAcpNativeSessions({
      instanceId,
      driverKind: "antigravity",
      displayName: "Google Antigravity",
      heldSessions: () => new Set(["held"]),
      listSessions: async () => {
        const listed = await readAcpSessionPages(async (cursor) => {
          requested.push(cursor);
          return pages[cursor ?? "first"];
        });
        if (listed === undefined) throw new Error("Expected readable pages");
        expect(listed.truncated).toBe(false);
        return listed;
      },
    });
    const listed = await Effect.runPromise(native.list({ instanceId, projectRoot: "/work/app" }));
    expect(listed.map((session) => session.nativeSessionId)).toEqual(["later"]);
    const adopted = await Effect.runPromise(
      native.adopt({
        instanceId,
        projectRoot: "/work/app",
        mode: "code",
        sessionId,
        nativeSessionId: "later",
        modelId,
      }),
    );
    expect(adopted.value).toBe("later");
    expect(requested).toEqual([undefined, "page-2", undefined, "page-2"]);
  });

  it("stops reading pages when the agent repeats a cursor or never stops paging", async () => {
    const repeating: Array<string | undefined> = [];
    const listed = await readAcpSessionPages(async (cursor) => {
      repeating.push(cursor);
      return { sessions: [{ sessionId: `s-${repeating.length}` }], nextCursor: "again" };
    });
    expect(repeating).toEqual([undefined, "again"]);
    expect(listed?.sessions.map((session) => session.sessionId)).toEqual(["s-1", "s-2"]);
    expect(listed?.truncated).toBe(true);

    let calls = 0;
    const endless = await readAcpSessionPages(async () => {
      calls += 1;
      return { sessions: [{ sessionId: `e-${calls}` }], nextCursor: `next-${calls}` };
    });
    expect(calls).toBeLessThanOrEqual(20);
    expect(endless?.sessions.length).toBe(calls);
    expect(endless?.truncated).toBe(true);

    const crowded = await readAcpSessionPages(async () => ({
      sessions: Array.from({ length: 2001 }, (_, index) => ({ sessionId: `c-${index}` })),
    }));
    expect(crowded?.sessions.length).toBe(2000);
    expect(crowded?.truncated).toBe(true);

    const overlong = await readAcpSessionPages(async () => ({
      sessions: [{ sessionId: "o" }],
      nextCursor: "x".repeat(4097),
    }));
    expect(overlong?.truncated).toBe(true);
  });

  it("refuses a later page it cannot read rather than offering a partial list", async () => {
    const listed = await readAcpSessionPages(async (cursor) =>
      cursor === undefined ? { sessions: [{ sessionId: "a" }], nextCursor: "b" } : { nope: true },
    );
    expect(listed).toBeUndefined();
  });
});

describe("an ACP agent's session history", () => {
  it("joins replayed message chunks into messages and names tool calls, leaving thoughts out", () => {
    expect(
      acpReplayedMessages([
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Find the " } },
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "flaky test" } },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } },
        { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run tests", kind: "execute" },
        { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It is " } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "timing out." } },
      ]),
    ).toEqual([
      { role: "person", text: "Find the flaky test" },
      { role: "agent", text: "It is timing out.", tools: ["Run tests"] },
    ]);
  });

  it("keeps the newest messages of a replay longer than its bound and counts the earlier ones as omitted", async () => {
    const replay = acpReplayCollector(4);
    const chunk = (role: "user" | "agent", text: string) => ({
      sessionUpdate: `${role}_message_chunk`,
      content: { type: "text", text },
    });
    for (const update of [
      chunk("user", "first question"),
      chunk("agent", "first "),
      chunk("agent", "answer"),
      chunk("user", "second "),
      chunk("user", "question"),
      chunk("agent", "second answer"),
      chunk("user", "newest question"),
      chunk("agent", "newest answer"),
    ])
      replay.add(update);
    const sessions = makeAcpNativeSessions({
      instanceId,
      driverKind: "antigravity",
      displayName: "Antigravity",
      heldSessions: () => new Set(),
      listSessions: async () => ({ sessions: [], truncated: false }),
      readHistory: async () => replay.collected(),
    });
    const history = sessions.history;
    if (history === undefined) throw new Error("A reader was given");
    // The bound keeps the second question's last chunk; its earlier chunk was
    // dropped, so the partial message is left out with the ones before it.
    expect(
      await Effect.runPromise(history({ instanceId, projectRoot: "/work", nativeSessionId: "s1" })),
    ).toEqual({
      status: "read",
      messages: [
        { role: "agent", text: "second answer" },
        { role: "person", text: "newest question" },
        { role: "agent", text: "newest answer" },
      ],
      omitted: 3,
    });
  });

  it("keeps a tool-heavy session's conversation whole when its thoughts, plans and tool progress alone exceed the bound", async () => {
    const replay = acpReplayCollector(4);
    const chunk = (role: "user" | "agent", text: string) => ({
      sessionUpdate: `${role}_message_chunk`,
      content: { type: "text", text },
    });
    replay.add(chunk("user", "Fix the build"));
    for (let step = 0; step < 50; step += 1) {
      replay.add({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
      replay.add({ sessionUpdate: "plan", entries: [] });
      replay.add({ sessionUpdate: "tool_call_update", toolCallId: `t${step}`, status: "done" });
    }
    replay.add({ sessionUpdate: "tool_call", toolCallId: "t50", title: "Run build" });
    replay.add(chunk("agent", "Fixed."));
    const sessions = makeAcpNativeSessions({
      instanceId,
      driverKind: "antigravity",
      displayName: "Antigravity",
      heldSessions: () => new Set(),
      listSessions: async () => ({ sessions: [], truncated: false }),
      readHistory: async () => replay.collected(),
    });
    const history = sessions.history;
    if (history === undefined) throw new Error("A reader was given");
    expect(
      await Effect.runPromise(history({ instanceId, projectRoot: "/work", nativeSessionId: "s1" })),
    ).toEqual({
      status: "read",
      messages: [
        { role: "person", text: "Fix the build" },
        { role: "agent", text: "Fixed.", tools: ["Run build"] },
      ],
    });
  });

  it("imports none from an agent that cannot load its sessions", async () => {
    const sessions = makeAcpNativeSessions({
      instanceId,
      driverKind: "antigravity",
      displayName: "Antigravity",
      heldSessions: () => new Set(),
      listSessions: async () => ({ sessions: [], truncated: false }),
      readHistory: async () => "unsupported",
    });
    const history = sessions.history;
    if (history === undefined) throw new Error("A reader was given");
    expect(
      await Effect.runPromise(history({ instanceId, projectRoot: "/work", nativeSessionId: "s1" })),
    ).toEqual({ status: "unsupported" });
  });
});
