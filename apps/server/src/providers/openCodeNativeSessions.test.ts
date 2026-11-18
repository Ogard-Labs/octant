import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
  type ProviderResumeCursor,
} from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeOpenCodeDriver,
  type OpenCodeClientPort,
  type OpenCodeListedSession,
} from "./openCodeDriver";
import type { OpenCodeProcessStartInput } from "./openCodeProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000b01");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000b02");
const otherSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000b03");
const forkedSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000b04");
const modelId = "anthropic/claude-sonnet" as ProviderModelId;
const projectRoot = "/work/project";

function listed(
  id: string,
  updated: number,
  extra: Partial<OpenCodeListedSession> = {},
): OpenCodeListedSession {
  return { id, directory: projectRoot, updated, ...extra };
}

/**
 * A driver over a stand-in OpenCode server: the sessions its store lists for
 * the folder, the messages each holds, and a record of each fork it made.
 */
function fixture(
  options: {
    readonly sessions?: ReadonlyArray<OpenCodeListedSession>;
    readonly messages?: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly held?: Set<string>;
    readonly forks?: false;
    /** A message the source's own thread adds while the fork is being made. */
    readonly appendedDuringFork?: string;
  } = {},
) {
  const sessions = options.sessions ?? [];
  const messages: Record<string, ReadonlyArray<string>> = { ...options.messages };
  const deleted: string[] = [];
  const held = options.held ?? new Set<string>();
  const forks: Array<{ readonly from: string; readonly before: string | undefined }> = [];
  const starts: OpenCodeProcessStartInput[] = [];
  const roots: string[] = [];
  const client: Partial<OpenCodeClientPort> = {
    getSession: async (id) => {
      const session = sessions.find((candidate) => candidate.id === id);
      if (session === undefined) throw new Error("session not found");
      return { id: session.id, directory: session.directory };
    },
    listSessions: async () => sessions,
    ...(options.forks === false
      ? {}
      : {
          messageAfter: async (id: string, messageId: string) => {
            const held = messages[id] ?? [];
            const index = held.indexOf(messageId);
            if (index < 0) return { status: "missing" as const };
            const next = held[index + 1];
            return next === undefined
              ? { status: "found" as const }
              : { status: "found" as const, next };
          },
          forkSession: async (id: string, before: string | undefined) => {
            forks.push({ from: id, before });
            if (options.appendedDuringFork !== undefined)
              messages[id] = [...(messages[id] ?? []), options.appendedDuringFork];
            return { id: `${id}-fork`, directory: projectRoot };
          },
          deleteSession: async (id: string) => {
            deleted.push(id);
          },
        }),
  };
  const driver = makeOpenCodeDriver({
    instanceId,
    binaryPath: "/opt/homebrew/bin/opencode",
    process: {
      start: (input) =>
        Effect.sync(() => {
          starts.push(input);
          return {
            authorization: "Basic redacted",
            pid: process.pid,
            url: new URL("http://127.0.0.1:1/"),
          };
        }),
    },
    runtimeRegistry: new ProviderRuntimeRegistry(),
    clientFactory: (_runtime, root) => {
      roots.push(root);
      return client as OpenCodeClientPort;
    },
    sessionOwnership: { held: (kind) => (kind === "opencode" ? held : new Set()) },
    idleLeaseMs: 0,
  });
  return { driver, forks, starts, roots, held, deleted };
}

function nativeSessions(driver: ReturnType<typeof fixture>["driver"]) {
  const native = driver.nativeSessions;
  if (native === undefined) throw new Error("OpenCode offers no sessions to start from");
  return native;
}

const adoptInput = (nativeSessionId: string, octantSessionId = sessionId) => ({
  instanceId,
  projectRoot,
  mode: "code" as const,
  sessionId: octantSessionId,
  nativeSessionId,
  modelId,
});

const sourceCursor: ProviderResumeCursor = {
  driverKind: "opencode",
  value: "ses_source",
  binding: { instanceId, sessionId, projectRoot, mode: "code", modelId },
};

describe("OpenCode's own sessions", () => {
  it("offers the person's sessions in this folder, newest first, leaving out held ones, subagents' and another folder's", async () => {
    const { driver, roots, starts } = fixture({
      sessions: [
        listed("ses_old", 10, { title: "Older work" }),
        listed("ses_new", 30, { title: "Newest work" }),
        listed("ses_held", 40),
        listed("ses_child", 50, { parentId: "ses_new" }),
        listed("ses_elsewhere", 60, { directory: "/work/other" }),
      ],
      held: new Set(["ses_held"]),
    });
    const offered = await Effect.runPromise(
      nativeSessions(driver).list({ instanceId, projectRoot }),
    );
    expect(offered).toEqual([
      { nativeSessionId: "ses_new", lastModified: 30, title: "Newest work" },
      { nativeSessionId: "ses_old", lastModified: 10, title: "Older work" },
    ]);
    // A server for the folder, outside any thread, reads the list.
    expect(roots).toEqual([projectRoot]);
    expect(starts.map((start) => start.cwd)).toEqual([projectRoot]);
  });

  it("takes up a session once: a second thread is refused until the claim is given back", async () => {
    const { driver } = fixture({ sessions: [listed("ses_person", 10)] });
    const native = nativeSessions(driver);
    const cursor = await Effect.runPromise(native.adopt(adoptInput("ses_person")));
    expect(cursor).toEqual({
      driverKind: "opencode",
      value: "ses_person",
      binding: { instanceId, sessionId, projectRoot, mode: "code", modelId },
    });
    expect(await Effect.runPromise(native.list({ instanceId, projectRoot }))).toEqual([]);
    const second = await Effect.runPromise(
      Effect.either(native.adopt(adoptInput("ses_person", otherSessionId))),
    );
    expect(second).toMatchObject({
      _tag: "Left",
      left: { message: "That OpenCode session already belongs to an Octant thread." },
    });
    // A release naming another Octant session leaves this one's claim.
    await Effect.runPromise(
      native.release?.({ instanceId, nativeSessionId: "ses_person", sessionId: otherSessionId }) ??
        Effect.void,
    );
    expect(await Effect.runPromise(native.list({ instanceId, projectRoot }))).toEqual([]);
    await Effect.runPromise(
      native.release?.({ instanceId, nativeSessionId: "ses_person", sessionId }) ?? Effect.void,
    );
    expect(
      (await Effect.runPromise(native.list({ instanceId, projectRoot }))).map(
        (session) => session.nativeSessionId,
      ),
    ).toEqual(["ses_person"]);
  });

  it("refuses a session the journal records another thread holding, one in another folder, and one OpenCode does not have", async () => {
    const { driver } = fixture({
      sessions: [listed("ses_held", 10), listed("ses_elsewhere", 20, { directory: "/work/other" })],
      held: new Set(["ses_held"]),
    });
    const native = nativeSessions(driver);
    for (const [id, message] of [
      ["ses_held", "That OpenCode session already belongs to an Octant thread."],
      ["ses_elsewhere", "That OpenCode session is not one of this folder's."],
      ["ses_missing", "That OpenCode session is not one of this folder's."],
    ] as const) {
      expect(await Effect.runPromise(Effect.either(native.adopt(adoptInput(id))))).toMatchObject({
        _tag: "Left",
        left: { message },
      });
    }
  });

  it("offers nothing to start from without the host's record of held sessions", () => {
    const driver = makeOpenCodeDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/opencode",
      process: { start: () => Effect.die("not started") },
      runtimeRegistry: new ProviderRuntimeRegistry(),
    });
    expect(driver.nativeSessions).toBeUndefined();
  });

  it("forks with OpenCode's own fork through the turn's last message, or the whole session when it is the newest", async () => {
    const { driver, forks } = fixture({
      messages: { ses_source: ["msg_1", "msg_2", "msg_3", "msg_4"] },
    });
    const forkSession = driver.forkSession;
    if (forkSession === undefined) throw new Error("OpenCode offers no fork");
    const request = {
      instanceId,
      sessionId: forkedSessionId,
      source: sourceCursor,
      anchor: "msg_2",
      projectRoot,
      mode: "code" as const,
      modelId,
    };
    expect(await Effect.runPromise(forkSession(request))).toEqual({
      driverKind: "opencode",
      value: "ses_source-fork",
      binding: { instanceId, sessionId: forkedSessionId, projectRoot, mode: "code", modelId },
    });
    await Effect.runPromise(forkSession({ ...request, anchor: "msg_4" }));
    expect(forks).toEqual([
      { from: "ses_source", before: "msg_3" },
      { from: "ses_source", before: undefined },
    ]);
  });

  it("removes a whole-session fork and hands over as text when the source moved past the anchor while it was copied", async () => {
    const { driver, forks, deleted } = fixture({
      messages: { ses_source: ["msg_1", "msg_2"] },
      appendedDuringFork: "msg_3",
    });
    const forkSession = driver.forkSession;
    if (forkSession === undefined) throw new Error("OpenCode offers no fork");
    expect(
      await Effect.runPromise(
        forkSession({
          instanceId,
          sessionId: forkedSessionId,
          source: sourceCursor,
          anchor: "msg_2",
          projectRoot,
          mode: "code",
          modelId,
        }),
      ),
    ).toBeUndefined();
    expect(forks).toEqual([{ from: "ses_source", before: undefined }]);
    expect(deleted).toEqual(["ses_source-fork"]);
  });

  it("hands a fork over as text for another folder or mode, an anchor OpenCode no longer holds, or a runtime that cannot fork", async () => {
    const { driver, forks } = fixture({ messages: { ses_source: ["msg_1"] } });
    const forkSession = driver.forkSession;
    if (forkSession === undefined) throw new Error("OpenCode offers no fork");
    const request = {
      instanceId,
      sessionId: forkedSessionId,
      source: sourceCursor,
      anchor: "msg_1",
      projectRoot,
      mode: "code" as const,
      modelId,
    };
    for (const refused of [
      { ...request, projectRoot: "/work/other" },
      { ...request, mode: "work" as const },
      { ...request, anchor: "msg_gone" },
      { ...request, source: { ...sourceCursor, driverKind: "pi" as const } },
    ])
      expect(await Effect.runPromise(forkSession(refused))).toBeUndefined();
    expect(forks).toEqual([]);
    const cannotFork = fixture({ forks: false }).driver.forkSession;
    if (cannotFork === undefined) throw new Error("OpenCode offers no fork");
    expect(await Effect.runPromise(cannotFork(request))).toBeUndefined();
  });
});
