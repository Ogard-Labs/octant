import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
} from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  acpListedSessions,
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
