import { describe, expect, it } from "vitest";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
  type ProviderResumeCursor,
  type ToolActionAuthority,
} from "@octant/contracts";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import { createThreadJournalLookup, newestChatAttemptSession } from "./nativeHarnessJournalLookup";
import { createNativeHarnessTools } from "./nativeHarnessTools";
import { MemoryNativeHarnessTranscriptStore } from "./nativeHarnessTranscriptStore";

const instanceId = decodeProviderInstanceId("00000000-0000-4000-8000-0000000000ee");
const otherInstanceId = decodeProviderInstanceId("00000000-0000-4000-8000-0000000000ef");
const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000a01");
const cursor: ProviderResumeCursor = { driverKind: "openai-compatible", value: String(sessionId) };
const projectRoot = "/tmp/octant-journal-lookup";
type Mode = "chat" | "work" | "code";

/** A Chat thread's authority names no Project, root, or worktree: it has no folder to reach. */
const authorityFor = (mode: Mode) =>
  ({
    hostId: "00000000-0000-4000-8000-0000000000aa",
    mode,
    ...(mode === "chat" ? {} : { projectId: "00000000-0000-4000-8000-0000000000bb" }),
    ...(mode === "code"
      ? {
          rootId: "00000000-0000-4000-8000-0000000000cc",
          worktreeId: "00000000-0000-4000-8000-0000000000dd",
        }
      : {}),
    providerInstanceId: instanceId,
    extension: { kind: "core" },
  }) as unknown as ToolActionAuthority;

function transcripts(mode: Mode = "code"): MemoryNativeHarnessTranscriptStore {
  const store = new MemoryNativeHarnessTranscriptStore();
  store.open(sessionId, {
    instanceId,
    modelId: "harness-model" as ProviderModelId,
    projectRoot,
    mode,
  });
  return store;
}

function lookupTools(input: {
  readonly store: MemoryNativeHarnessTranscriptStore;
  readonly session?: { readonly providerInstanceId: typeof instanceId } | undefined;
  readonly secrets?: ReadonlyArray<string>;
  readonly authorized?: boolean;
  readonly mode?: Mode;
}) {
  const mode = input.mode ?? "code";
  const authority = authorityFor(mode);
  return createNativeHarnessTools({
    threadId: "thread-1",
    mode,
    authority: new ToolCallAuthorityService({
      resolveGrantedAuthority: () => authority,
      resolveLiveFacts: () => ({
        providerAppManagedTools: "supported",
        host: { computerUseEnabled: false },
        // A Code lead reads its journal even in Plan, which allows nothing it could change.
        executionPolicy: mode === "code" ? "plan" : "approval-gated",
        approvalSatisfied: false,
        externalContentIngested: false,
      }),
    }),
    resolveAuthority: () => (input.authorized === false ? undefined : authority),
    ports: {
      journalLookup: createThreadJournalLookup({
        mode,
        transcripts: input.store,
        latestSession: () =>
          input.session === undefined ? undefined : { ...input.session, resumeCursor: cursor },
        providerInstanceId: instanceId,
        secrets: input.secrets ?? [],
      }),
    },
    uuid: () => "00000000-0000-4000-8000-000000000099",
  });
}

const lookUp = (tools: ReturnType<typeof lookupTools>, input: unknown) =>
  tools.execute({ name: "journal-lookup", inputJson: JSON.stringify(input) });

describe("journal lookup", () => {
  it.each(["chat", "work", "code"] as const)(
    "reads back an earlier exchange of a %s conversation by message number, bounded, and says where to continue",
    async (mode) => {
      const store = transcripts(mode);
      store.append(sessionId, { role: "user", text: "Why does the queue stall?" });
      store.append(sessionId, {
        role: "assistant",
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "read", argumentsJson: '{"path":"queue.ts"}' }],
      });
      store.settle(sessionId, {
        toolCallId: "c1",
        resultJson: JSON.stringify("x".repeat(20_000)),
        isError: false,
      });
      store.append(sessionId, { role: "assistant", text: "The lock is never released." });
      store.append(sessionId, { role: "user", text: "Fix it." });
      const tools = lookupTools({ store, session: { providerInstanceId: instanceId }, mode });

      const read = await lookUp(tools, { from: 1, count: 2 });

      expect(read.isError).toBe(false);
      expect(read.result).toMatchObject({
        total: 5,
        next: 3,
        messages: [
          { number: 1, role: "assistant", toolCalls: [{ toolCallId: "c1", toolName: "read" }] },
          { number: 2, role: "assistant", toolResults: [{ toolCallId: "c1", isError: false }] },
        ],
      });
      const result = JSON.stringify(read.result);
      expect(result).toContain("more characters left out");
      expect(result.length).toBeLessThan(10_000);
      expect(await lookUp(tools, { from: 3 })).toMatchObject({
        isError: false,
        result: {
          total: 5,
          messages: [
            { number: 3, text: "The lock is never released." },
            { number: 4, text: "Fix it." },
          ],
        },
      });
    },
  );

  it("refuses a missing message, another thread's handle, a foreign session, and a revoked thread", async () => {
    const store = transcripts();
    store.append(sessionId, { role: "user", text: "Only message." });
    const tools = lookupTools({ store, session: { providerInstanceId: instanceId } });

    expect(await lookUp(tools, { from: 7 })).toMatchObject({
      isError: true,
      result: { error: "journal-message-missing", message: expect.stringContaining("0 to 0") },
    });
    // A lookup names only a message number; a call that tries to name a
    // thread or a session is refused before anything is read.
    expect(await lookUp(tools, { from: 0, threadId: "another-thread" })).toMatchObject({
      isError: true,
      result: { error: "invalid-tool-input" },
    });
    expect(
      await lookUp(lookupTools({ store, session: { providerInstanceId: otherInstanceId } }), {
        from: 0,
      }),
    ).toMatchObject({ isError: true, result: { error: "journal-unavailable" } });
    expect(await lookUp(lookupTools({ store, session: undefined }), { from: 0 })).toMatchObject({
      isError: true,
      result: { error: "journal-unavailable" },
    });
    expect(
      await lookUp(
        lookupTools({ store, session: { providerInstanceId: instanceId }, authorized: false }),
        { from: 0 },
      ),
    ).toMatchObject({ isError: true, result: { error: "tool-authority-stale" } });
  });

  it.each([
    ["chat", "code"],
    ["work", "chat"],
    ["code", "work"],
  ] as const)(
    "refuses a %s thread a session journaled for %s, whatever its own journal records",
    async (mode, journaledFor) => {
      const store = transcripts(journaledFor);
      store.append(sessionId, { role: "user", text: "Another mode's message." });

      const read = await lookUp(
        lookupTools({ store, session: { providerInstanceId: instanceId }, mode }),
        { from: 0 },
      );

      expect(read).toMatchObject({ isError: true, result: { error: "journal-unavailable" } });
      expect(JSON.stringify(read.result)).not.toContain("Another mode");
    },
  );

  it("reads a Chat thread's session from the attempt it created last, even one regenerating an earlier turn", () => {
    const at = (createdAt: string, value: string) => ({
      providerInstanceId: instanceId,
      createdAt,
      resumeCursor: { driverKind: "openai-compatible", value } as ProviderResumeCursor,
    });
    const tail = at("2026-10-26T10:00:00.000Z", "tail-session");
    const regenerated = at("2026-10-26T10:05:00.000Z", "regenerated-session");

    expect(
      newestChatAttemptSession([
        { attempts: [at("2026-10-26T09:00:00.000Z", "first-session"), regenerated] },
        { attempts: [tail] },
      ])?.resumeCursor?.value,
    ).toBe("regenerated-session");
    expect(newestChatAttemptSession([{ attempts: [] }])).toBeUndefined();
  });

  it("never returns a credential the turn resolved, even escaped inside a tool payload", async () => {
    const secret = 'sk-live-"quoted"-4242';
    const store = transcripts();
    store.append(sessionId, { role: "user", text: `Use the key ${secret} for the deploy.` });
    store.append(sessionId, {
      role: "assistant",
      text: "",
      toolCalls: [
        {
          toolCallId: "c1",
          toolName: "bash",
          argumentsJson: JSON.stringify({ command: `deploy --token ${secret}` }),
        },
      ],
    });
    store.settle(sessionId, {
      toolCallId: "c1",
      resultJson: JSON.stringify({ output: `authorized with ${secret}` }),
      isError: false,
    });
    const tools = lookupTools({
      store,
      session: { providerInstanceId: instanceId },
      secrets: [secret],
    });

    const read = await lookUp(tools, { from: 0 });

    const result = JSON.stringify(read.result);
    expect(read.isError).toBe(false);
    expect(result).not.toContain("sk-live");
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(3);
    // Only the conversation's own messages leave: no binding, session, or
    // other journal record rides along.
    expect(Object.keys(read.result as object).sort()).toEqual(["messages", "total"]);
  });
});
