import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
} from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  acpListedSessions,
  acpReplayedMessages,
  makeAcpNativeSessions,
  type AcpListedSession,
} from "./acpNativeSessions";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000b01");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000b02");
const modelId = decodeProviderModelId("gemini-3.8-flash");

function sessions(listed: ReadonlyArray<AcpListedSession> | "unsupported", held: string[] = []) {
  return makeAcpNativeSessions({
    instanceId,
    driverKind: "antigravity",
    displayName: "Google Antigravity",
    heldSessions: () => new Set(held),
    listSessions: async () => listed,
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

  it("imports none from an agent that cannot load its sessions", async () => {
    const sessions = makeAcpNativeSessions({
      instanceId,
      driverKind: "antigravity",
      displayName: "Antigravity",
      heldSessions: () => new Set(),
      listSessions: async () => [],
      readHistory: async () => "unsupported",
    });
    const history = sessions.history;
    if (history === undefined) throw new Error("A reader was given");
    expect(
      await Effect.runPromise(history({ instanceId, projectRoot: "/work", nativeSessionId: "s1" })),
    ).toEqual({ status: "unsupported" });
  });
});
