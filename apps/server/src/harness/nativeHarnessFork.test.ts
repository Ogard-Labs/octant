import type {
  CodeConversationTurn,
  CodeThread,
  NativeHarnessTranscriptMessage,
  ProviderSessionId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  nativeHarnessForkPrefix,
  rewriteForFork,
  seedCodeForkHarnessSession,
} from "./nativeHarnessFork";
import { MemoryNativeHarnessTranscriptStore } from "./nativeHarnessTranscriptStore";

const instanceId = "00000000-0000-4000-8000-0000000000a1";
const sourceRoot = "/work/source";
const forkRoot = "/work/.octant-worktrees/repo/fork";
const SESSION_IDS: Readonly<Record<string, string>> = {
  source: "00000000-0000-4000-8000-0000000000b1",
  fork: "00000000-0000-4000-8000-0000000000b2",
};
const session = (name: string) => (SESSION_IDS[name] ?? name) as ProviderSessionId;

const user = (text: string): NativeHarnessTranscriptMessage => ({ role: "user", text });
const reply = (text: string): NativeHarnessTranscriptMessage => ({ role: "assistant", text });
const call = (id: string, path: string): NativeHarnessTranscriptMessage => ({
  role: "assistant",
  text: "",
  toolCalls: [{ toolCallId: id, toolName: "read", argumentsJson: JSON.stringify({ path }) }],
});
const result = (id: string, body: string): NativeHarnessTranscriptMessage => ({
  role: "assistant",
  text: "",
  toolResults: [{ toolCallId: id, resultJson: JSON.stringify({ body }), isError: false }],
});

/** A source transcript of two turns, the first of which read a file. */
function twoTurnSource(store: MemoryNativeHarnessTranscriptStore, id = "source") {
  store.open(session(id), {
    instanceId,
    modelId: "m",
    projectRoot: sourceRoot,
    mode: "code",
  } as never);
  for (const message of [
    user("Read the config."),
    call("c1", `${sourceRoot}/config.json`),
    result("c1", "token=sk-live-123"),
    reply("It sets the token."),
    user("Now delete it."),
    reply("Deleted."),
  ]) {
    store.append(session(id), message);
  }
}

describe("forking a harness conversation", () => {
  it("keeps the lead's messages, tool calls, and results through the chosen turn and nothing after", () => {
    const store = new MemoryNativeHarnessTranscriptStore();
    twoTurnSource(store);
    const transcript = store.load(session("source"));
    if (transcript === undefined) throw new Error("no transcript");

    const prefix = nativeHarnessForkPrefix(transcript, { ownTurns: 2, throughTurn: 1 });

    expect(prefix?.turns).toBe(1);
    expect(prefix?.messages.map((message) => message.text)).toEqual([
      "Read the config.",
      "",
      "",
      "It sets the token.",
    ]);
  });

  it("refuses to cut when the transcript holds a different number of turns than the thread ran", () => {
    const store = new MemoryNativeHarnessTranscriptStore();
    twoTurnSource(store);
    const transcript = store.load(session("source"));
    if (transcript === undefined) throw new Error("no transcript");

    // Three thread turns used this session, but one never reached the model.
    expect(nativeHarnessForkPrefix(transcript, { ownTurns: 3, throughTurn: 2 })).toBeUndefined();
  });

  it("counts a fork's inherited turns before its own when that fork is forked again", () => {
    const store = new MemoryNativeHarnessTranscriptStore();
    store.open(
      session("fork"),
      { instanceId, modelId: "m", projectRoot: forkRoot, mode: "code" } as never,
      { sessionId: session("source"), turns: 1 },
    );
    for (const message of [user("Inherited."), reply("Yes."), user("Own turn."), reply("Done.")]) {
      store.append(session("fork"), message);
    }
    const transcript = store.load(session("fork"));
    if (transcript === undefined) throw new Error("no transcript");

    const prefix = nativeHarnessForkPrefix(transcript, { ownTurns: 1, throughTurn: 1 });

    expect(prefix?.turns).toBe(2);
    expect(prefix?.messages).toHaveLength(4);
  });

  it("points copied paths at the fork's folder and never carries a resolved secret", () => {
    const rewritten = [
      call("c1", `${sourceRoot}/config.json`),
      result("c1", "token=sk-live-123"),
      user(`Look in ${sourceRoot} for sk-live-123`),
    ].map((message) =>
      rewriteForFork(message, { fromRoot: sourceRoot, toRoot: forkRoot, secrets: ["sk-live-123"] }),
    );

    expect(rewritten[0]?.toolCalls?.[0]?.argumentsJson).toBe(
      JSON.stringify({ path: `${forkRoot}/config.json` }),
    );
    expect(rewritten[1]?.toolResults?.[0]?.resultJson).toBe(
      JSON.stringify({ body: "token=[REDACTED]" }),
    );
    expect(rewritten[2]?.text).toBe(`Look in ${forkRoot} for [REDACTED]`);
  });

  it("seeds a Code fork's session from the source's transcript and leaves the source as it was", async () => {
    const store = new MemoryNativeHarnessTranscriptStore();
    twoTurnSource(store);
    const before = store.load(session("source"));
    // Each turn names the session it asked for; a resume carried both into
    // the one conversation the source's transcript holds.
    const turns = [
      { operationId: "op-1", sessionId: "asked-1", status: "completed" },
      { operationId: "op-2", sessionId: "asked-2", status: "completed" },
    ] as never as ReadonlyArray<CodeConversationTurn>;
    const fork = { providerInstanceId: instanceId } as never as CodeThread;

    const cursor = await seedCodeForkHarnessSession(
      {
        transcripts: store,
        harnessDriverKind: () => "anthropic-compatible",
        sourceTurns: () => turns,
        sourceConversations: () =>
          new Map([
            ["op-1", String(session("source"))],
            ["op-2", String(session("source"))],
          ]),
      },
      {
        fork,
        origin: { threadId: "source-thread", throughOperationId: "op-1" } as never,
        sessionId: session("fork"),
        checkoutRoot: forkRoot,
        secrets: ["sk-live-123"],
      },
    );

    expect(cursor).toEqual({ driverKind: "anthropic-compatible", value: String(session("fork")) });
    const seeded = store.load(session("fork"));
    expect(seeded?.binding.projectRoot).toBe(forkRoot);
    expect(seeded?.forkedFrom).toEqual({ sessionId: session("source"), turns: 1 });
    expect(seeded?.messages.map((message) => message.text)).toEqual([
      "Read the config.",
      "",
      "",
      "It sets the token.",
    ]);
    expect(JSON.stringify(seeded)).not.toContain("sk-live-123");
    expect(store.load(session("source"))).toEqual(before);
  });

  it("leaves a fork on another provider to read the source's history as text", async () => {
    const store = new MemoryNativeHarnessTranscriptStore();
    twoTurnSource(store);

    const cursor = await seedCodeForkHarnessSession(
      {
        transcripts: store,
        harnessDriverKind: () => undefined,
        sourceTurns: () => [],
        sourceConversations: () => new Map(),
      },
      {
        fork: { providerInstanceId: instanceId } as never as CodeThread,
        origin: { threadId: "source-thread", throughOperationId: "op-1" } as never,
        sessionId: session("fork"),
        checkoutRoot: forkRoot,
        secrets: [],
      },
    );

    expect(cursor).toBeUndefined();
    expect(store.load(session("fork"))).toBeUndefined();
  });
});
