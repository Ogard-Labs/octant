import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  decodeMentionableThreadId,
  decodeWindowId,
  type ChatThreadId,
  type MentionableThreadId,
  type ThreadMentionTranscriptEntry,
  type UtcTimestamp,
} from "@octant/contracts";
import { SideChatSidecarStore } from "./sideChatSidecarStore";
import {
  createChatSideChatThreadFactory,
  createChatThreadMentionDirectory,
  createCodeThreadMentionDirectory,
  createWorkThreadMentionDirectory,
  ThreadMentionService,
  type ThreadMentionDirectory,
  type ThreadMentionDirectoryThread,
} from "./threadMentionService";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000001");
const requestId = "00000000-0000-4000-8000-000000000002";
const chatThreadId = decodeMentionableThreadId("00000000-0000-4000-8000-000000000101");
const workThreadId = decodeMentionableThreadId("00000000-0000-4000-8000-000000000102");
const secretThreadId = decodeMentionableThreadId("00000000-0000-4000-8000-000000000103");
const providerInstanceId = "00000000-0000-4000-8000-0000000000aa" as never;

let root: string;
let sidecars: SideChatSidecarStore;

function thread(
  threadId: MentionableThreadId,
  overrides: Partial<ThreadMentionDirectoryThread> = {},
): ThreadMentionDirectoryThread {
  return {
    threadId,
    mode: "chat",
    title: "Release notes",
    placement: { kind: "unfiled" },
    updatedAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
    ...overrides,
  };
}

function entry(text: string): ThreadMentionTranscriptEntry {
  return { role: "user", text, occurredAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp };
}

function directory(
  mode: ThreadMentionDirectory["mode"],
  threads: ReadonlyArray<ThreadMentionDirectoryThread>,
  transcripts: ReadonlyMap<string, ReadonlyArray<ThreadMentionTranscriptEntry>> = new Map(),
): ThreadMentionDirectory {
  return {
    mode,
    listOpenable: vi.fn().mockResolvedValue(threads),
    readTranscript: vi.fn(async (_window, threadId) => transcripts.get(String(threadId))),
  };
}

function sequentialUuid(start = 0): () => string {
  let next = start;
  return () => `00000000-0000-4000-8000-0000000004${String(++next).padStart(2, "0")}`;
}

/**
 * A Chat command surface that remembers every thread it committed, which is
 * what makes an orphan observable: a minted id no sidecar link names is a
 * thread the user is left with in Recents.
 */
function sideChatThreads(
  options: {
    readonly minted?: Map<string, string>;
    readonly failAfterMint?: boolean;
  } = {},
) {
  const minted = options.minted ?? new Map<string, string>();
  return {
    minted,
    ensure: vi.fn(
      async ({ threadId, title }: { readonly threadId: ChatThreadId; readonly title: string }) => {
        if (minted.has(String(threadId))) return false;
        minted.set(String(threadId), title);
        if (options.failAfterMint) throw new Error("chat down");
        return true;
      },
    ),
  };
}

/**
 * The Chat command surface the real sidecar factory drives, remembering what
 * it committed so an unfinished sidecar — a thread that exists without the
 * inherited selection — is observable rather than inferred.
 */
function chatCommandSurface(): {
  providerReady: boolean;
  readonly threads: Map<
    string,
    { readonly version: number; providerInstanceId?: string; modelId?: string }
  >;
  readonly execute: (command: unknown) => Promise<unknown>;
  readonly read: (threadId: ChatThreadId) => unknown;
} {
  const threads = new Map<
    string,
    { readonly version: number; providerInstanceId?: string; modelId?: string }
  >();
  const surface = {
    providerReady: false,
    threads,
    execute: async (input: unknown) => {
      const command = input as {
        readonly kind: string;
        readonly threadId: string;
        readonly providerInstanceId?: string;
        readonly modelId?: string;
      };
      const key = String(command.threadId);
      if (command.kind === "create-chat-thread") {
        if (threads.has(key)) throw new Error("Chat thread already exists.");
        threads.set(key, { version: 1 });
        return { kind: "thread-created", thread: { id: key, version: 1 } };
      }
      if (command.kind === "change-chat-provider") {
        const existing = threads.get(key);
        if (existing === undefined) throw new Error("Chat thread was not found.");
        if (!surface.providerReady) throw new Error("Selected provider is not ready for Chat.");
        const next = {
          version: existing.version + 1,
          providerInstanceId: String(command.providerInstanceId),
          modelId: String(command.modelId),
        };
        threads.set(key, next);
        return { kind: "thread-updated", thread: { id: key, ...next } };
      }
      throw new Error(`unexpected command ${command.kind}`);
    },
    read: (threadId: ChatThreadId) => {
      const existing = threads.get(String(threadId));
      return existing === undefined ? undefined : { thread: { id: String(threadId), ...existing } };
    },
  };
  return surface;
}

function createService(
  directories: ReadonlyArray<ThreadMentionDirectory>,
  threads = sideChatThreads(),
) {
  return {
    threads,
    service: new ThreadMentionService({
      directories,
      sidecars,
      sideChatThreads: threads,
      clock: () => "2026-08-14T11:00:00.000Z",
      uuid: sequentialUuid(),
    }),
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-mention-"));
  sidecars = new SideChatSidecarStore(root);
  await sidecars.hydrate();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ThreadMentionService search", () => {
  it("returns openable threads across modes, newest first", async () => {
    const { service } = createService([
      directory("chat", [thread(chatThreadId, { title: "Alpha" })]),
      directory("work", [
        thread(workThreadId, {
          mode: "work",
          title: "Beta",
          updatedAt: "2026-08-14T12:00:00.000Z" as UtcTimestamp,
        }),
      ]),
    ]);

    const result = await service.execute(
      { kind: "search-mentions", requestId, query: "" },
      { windowId },
    );

    expect(result.kind).toBe("mentions-searched");
    if (result.kind !== "mentions-searched") return;
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(["Beta", "Alpha"]);
    expect(result.candidates[0]!.mode).toBe("work");
  });

  it("omits threads a mode's Open check refused rather than disabling them", async () => {
    const { service } = createService([directory("chat", [thread(chatThreadId)])]);

    const result = await service.execute(
      { kind: "search-mentions", requestId, query: "" },
      { windowId },
    );

    if (result.kind !== "mentions-searched") throw new Error("expected search result");
    expect(result.candidates.map((candidate) => String(candidate.threadId))).not.toContain(
      String(secretThreadId),
    );
  });

  it("keeps the picker usable when one mode's directory is unavailable", async () => {
    const failing: ThreadMentionDirectory = {
      mode: "code",
      listOpenable: vi.fn().mockRejectedValue(new Error("code service down")),
      readTranscript: vi.fn().mockResolvedValue(undefined),
    };
    const { service } = createService([directory("chat", [thread(chatThreadId)]), failing]);

    const result = await service.execute(
      { kind: "search-mentions", requestId, query: "" },
      { windowId },
    );

    if (result.kind !== "mentions-searched") throw new Error("expected search result");
    expect(result.candidates).toHaveLength(1);
  });

  it("marks a candidate that already has a Side Chat sidecar", async () => {
    await sidecars.record({
      sourceThreadId: chatThreadId,
      sourceMode: "chat",
      sidecarThreadId: decodeChatThreadId("00000000-0000-4000-8000-000000000201"),
      title: "Side Chat about Release notes",
      createdAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
    });
    // Only a finished sidecar is one the picker may offer to reopen.
    await sidecars.confirmInheritance(chatThreadId);
    const { service } = createService([directory("chat", [thread(chatThreadId)])]);

    const result = await service.execute(
      { kind: "search-mentions", requestId, query: "" },
      { windowId },
    );

    if (result.kind !== "mentions-searched") throw new Error("expected search result");
    expect(String(result.candidates[0]!.sideChatThreadId)).toBe(
      "00000000-0000-4000-8000-000000000201",
    );
  });

  it("never lists a sidecar as itself mentionable", async () => {
    const sidecarThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000201");
    await sidecars.record({
      sourceThreadId: chatThreadId,
      sourceMode: "chat",
      sidecarThreadId,
      title: "Side Chat about Release notes",
      createdAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
    });
    const { service } = createService([
      directory("chat", [
        thread(chatThreadId),
        thread(decodeMentionableThreadId(String(sidecarThreadId)), { title: "Side Chat" }),
      ]),
    ]);

    const result = await service.execute(
      { kind: "search-mentions", requestId, query: "" },
      { windowId },
    );

    if (result.kind !== "mentions-searched") throw new Error("expected search result");
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(["Release notes"]);
  });
});

describe("ThreadMentionService resolve", () => {
  it("returns a bounded transcript window and never mutates the mentioned thread", async () => {
    const chat = directory(
      "chat",
      [thread(chatThreadId)],
      new Map([[String(chatThreadId), Array.from({ length: 30 }, (_, i) => entry(`line ${i}`))]]),
    );
    const { service } = createService([chat]);

    const result = await service.execute(
      { kind: "resolve-mentions", requestId, threadIds: [chatThreadId] },
      { windowId },
    );

    if (result.kind !== "mentions-resolved") throw new Error("expected resolve result");
    expect(result.mentions[0]!.transcript).toHaveLength(12);
    expect(result.mentions[0]!.truncated).toBe(true);
    expect(Object.keys(chat)).toEqual(["mode", "listOpenable", "readTranscript"]);
  });

  it("fails closed with only the opaque id when Open would be refused", async () => {
    const { service } = createService([directory("chat", [thread(chatThreadId)])]);

    const result = await service.execute(
      { kind: "resolve-mentions", requestId, threadIds: [secretThreadId] },
      { windowId },
    );

    if (result.kind !== "mentions-resolved") throw new Error("expected resolve result");
    expect(result.mentions).toEqual([]);
    expect(result.unavailable).toEqual([{ threadId: secretThreadId, reason: "unauthorized" }]);
  });

  it("marks a thread whose transcript read failed as not-found", async () => {
    const { service } = createService([directory("chat", [thread(chatThreadId)])]);

    const result = await service.execute(
      { kind: "resolve-mentions", requestId, threadIds: [chatThreadId] },
      { windowId },
    );

    if (result.kind !== "mentions-resolved") throw new Error("expected resolve result");
    expect(result.unavailable).toEqual([{ threadId: chatThreadId, reason: "not-found" }]);
  });

  it("resolves a cross-mode mention under the same Open rule", async () => {
    const { service } = createService([
      directory("chat", [thread(chatThreadId)]),
      directory(
        "work",
        [thread(workThreadId, { mode: "work", title: "Work brief" })],
        new Map([[String(workThreadId), [entry("hello")]]]),
      ),
    ]);

    const result = await service.execute(
      { kind: "resolve-mentions", requestId, threadIds: [workThreadId] },
      { windowId },
    );

    if (result.kind !== "mentions-resolved") throw new Error("expected resolve result");
    expect(result.mentions[0]!.mode).toBe("work");
    expect(result.mentions[0]!.transcript.map((line) => line.text)).toEqual(["hello"]);
  });
});

describe("ThreadMentionService side chat", () => {
  it("creates one Chat sidecar inheriting the source provider and model", async () => {
    const { threads, service } = createService([
      directory("chat", [
        thread(workThreadId, {
          mode: "work",
          title: "Release notes",
          providerInstanceId,
          modelId: "gpt-5" as never,
        }),
      ]),
    ]);

    const result = await service.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: workThreadId },
      { windowId },
    );

    if (result.kind !== "side-chat-opened") throw new Error("expected side chat result");
    expect(threads.ensure).toHaveBeenCalledWith({
      threadId: result.sidecar.sidecarThreadId,
      title: "Side Chat about Release notes",
      providerInstanceId,
      modelId: "gpt-5",
    });
    expect(result.created).toBe(true);
    expect(result.sidecar.sourceMode).toBe("work");
  });

  it("reopens the existing sidecar instead of minting a second", async () => {
    const { threads, service } = createService([directory("chat", [thread(chatThreadId)])]);
    await service.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );

    const second = await service.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );

    expect(threads.minted.size).toBe(1);
    if (second.kind !== "side-chat-opened") throw new Error("expected side chat result");
    expect(second.created).toBe(false);
  });

  it("admits one sidecar when two opens race, stranding no orphan Chat thread", async () => {
    const { threads, service } = createService([directory("chat", [thread(chatThreadId)])]);

    const [first, second] = await Promise.all([
      service.execute(
        { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
        { windowId },
      ),
      service.execute(
        { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
        { windowId },
      ),
    ]);

    // A losing open must never have committed a second Chat thread: an
    // uncommitted loser is the only way Recents stays free of an orphaned
    // "Side Chat about …" thread that no sidecar link hides.
    expect(threads.minted.size).toBe(1);
    expect(sidecars.hiddenThreadIds().size).toBe(1);
    if (first.kind !== "side-chat-opened" || second.kind !== "side-chat-opened") {
      throw new Error("expected side chat results");
    }
    expect(String(second.sidecar.sidecarThreadId)).toBe(String(first.sidecar.sidecarThreadId));
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
  });

  it("refuses a source thread the principal cannot Open", async () => {
    const { threads, service } = createService([directory("chat", [thread(chatThreadId)])]);

    const result = await service.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: secretThreadId },
      { windowId },
    );

    expect(threads.minted.size).toBe(0);
    expect(result).toEqual({ kind: "failed", requestId, reason: "unauthorized" });
  });

  it("reports unavailable when the sidecar thread cannot be created", async () => {
    const { service } = createService(
      [directory("chat", [thread(chatThreadId)])],
      sideChatThreads({ failAfterMint: true }),
    );

    const result = await service.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );

    expect(result).toEqual({ kind: "failed", requestId, reason: "unavailable" });
  });

  it("refuses the open when the source provider cannot be inherited", async () => {
    // Every sidecar turn carries the source thread's transcript, so the
    // inherited selection decides where that transcript is transmitted. A
    // sidecar left on the Chat default would send it to a provider the user
    // never chose for the source thread, so the open fails instead.
    const chat = chatCommandSurface();
    const service = new ThreadMentionService({
      directories: [
        directory("chat", [
          thread(chatThreadId, { providerInstanceId, modelId: "gpt-5" as never }),
        ]),
      ],
      sidecars,
      sideChatThreads: createChatSideChatThreadFactory(chat),
      clock: () => "2026-08-14T11:00:00.000Z",
      uuid: sequentialUuid(),
    });

    const result = await service.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );

    expect(result).toEqual({ kind: "failed", requestId, reason: "unavailable" });
    // Nothing may treat the unfinished claim as this source's Side Chat: the
    // send path resolves the source thread through exactly these two reads, so
    // no turn on the created thread can carry the source transcript.
    expect(sidecars.find(chatThreadId)).toBeUndefined();
    expect(
      sidecars.findBySidecarThread(decodeChatThreadId("00000000-0000-4000-8000-000000000401")),
    ).toBeUndefined();
    // The claim still hides the thread it named, so the failed open leaves no
    // orphaned "Side Chat about …" row in Recents either.
    expect(sidecars.hiddenThreadIds().has("00000000-0000-4000-8000-000000000401")).toBe(true);
  });

  it("finishes the same claim once the source provider can be inherited again", async () => {
    const chat = chatCommandSurface();
    const failing = new ThreadMentionService({
      directories: [
        directory("chat", [
          thread(chatThreadId, { providerInstanceId, modelId: "gpt-5" as never }),
        ]),
      ],
      sidecars,
      sideChatThreads: createChatSideChatThreadFactory(chat),
      clock: () => "2026-08-14T11:00:00.000Z",
      uuid: sequentialUuid(),
    });
    const failed = await failing.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );
    expect(failed).toEqual({ kind: "failed", requestId, reason: "unavailable" });

    // Restart: the claim is durable, so the retry is the one after a reboot.
    const reloaded = new SideChatSidecarStore(root);
    await reloaded.hydrate();
    expect(reloaded.find(chatThreadId)).toBeUndefined();
    const restarted = new ThreadMentionService({
      directories: [
        directory("chat", [
          thread(chatThreadId, { providerInstanceId, modelId: "gpt-5" as never }),
        ]),
      ],
      sidecars: reloaded,
      sideChatThreads: createChatSideChatThreadFactory(chat),
      clock: () => "2026-08-14T11:00:00.000Z",
      uuid: sequentialUuid(50),
    });
    chat.providerReady = true;

    const opened = await restarted.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );

    if (opened.kind !== "side-chat-opened") throw new Error("expected side chat result");
    // The claimed id, not a second one, and now carrying the source selection.
    expect(String(opened.sidecar.sidecarThreadId)).toBe("00000000-0000-4000-8000-000000000401");
    expect([...chat.threads.keys()]).toEqual(["00000000-0000-4000-8000-000000000401"]);
    expect(chat.threads.get("00000000-0000-4000-8000-000000000401")).toMatchObject({
      providerInstanceId: String(providerInstanceId),
      modelId: "gpt-5",
    });
    expect(reloaded.find(chatThreadId)).toEqual(opened.sidecar);
    expect(reloaded.findBySidecarThread(opened.sidecar.sidecarThreadId)).toEqual(opened.sidecar);
  });

  it("mints no second sidecar over a registry it could not read", async () => {
    // The registry is the only record of which Chat threads are sidecars, so
    // reading a corrupt one as "no sidecars" would mint a duplicate for a
    // source that already has one and flush the corrupt file away with it.
    await mkdir(join(root, "side-chat"), { recursive: true });
    await writeFile(join(root, "side-chat", "sidecars.json"), '[{"sourceThread', "utf8");
    const corrupt = new SideChatSidecarStore(root);
    await corrupt.hydrate();
    const threads = sideChatThreads();
    const service = new ThreadMentionService({
      directories: [directory("chat", [thread(chatThreadId)])],
      sidecars: corrupt,
      sideChatThreads: threads,
      clock: () => "2026-08-14T11:00:00.000Z",
      uuid: sequentialUuid(),
    });

    const result = await service.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );

    expect(result).toEqual({ kind: "failed", requestId, reason: "unavailable" });
    expect(threads.minted.size).toBe(0);
    expect(await readFile(join(root, "side-chat", "sidecars.json"), "utf8")).toBe(
      '[{"sourceThread',
    );
  });

  it("mints no Chat thread when the sidecar link cannot be written, and one on retry", async () => {
    // The registry directory is a file, so every write fails until it is gone.
    const blockedRoot = join(root, "unwritable");
    await writeFile(blockedRoot, "");
    const blocked = new SideChatSidecarStore(blockedRoot);
    await blocked.hydrate();
    const threads = sideChatThreads();
    const service = new ThreadMentionService({
      directories: [directory("chat", [thread(chatThreadId)])],
      sidecars: blocked,
      sideChatThreads: threads,
      clock: () => "2026-08-14T11:00:00.000Z",
      uuid: sequentialUuid(),
    });

    const failed = await service.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );

    expect(failed).toEqual({ kind: "failed", requestId, reason: "unavailable" });
    // A Chat thread committed before the link that hides it is an orphan: it
    // is durable, unlinked, and therefore an ordinary Recent forever.
    expect(threads.minted.size).toBe(0);

    await rm(blockedRoot);
    const retried = await service.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );

    if (retried.kind !== "side-chat-opened") throw new Error("expected side chat result");
    expect(retried.created).toBe(true);
    // Exactly one usable sidecar, not one usable sidecar beside an orphan.
    expect([...threads.minted.keys()]).toEqual([String(retried.sidecar.sidecarThreadId)]);
    expect(blocked.list()).toHaveLength(1);
  });

  it("finishes a claimed sidecar after a restart instead of minting a second", async () => {
    // Chat commits the thread and the call then fails — a host crash or a lost
    // response, i.e. exactly the window a create-first admission cannot close.
    const crashing = sideChatThreads({ failAfterMint: true });
    const first = new ThreadMentionService({
      directories: [directory("chat", [thread(chatThreadId)])],
      sidecars,
      sideChatThreads: crashing,
      clock: () => "2026-08-14T11:00:00.000Z",
      uuid: sequentialUuid(),
    });

    const failed = await first.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );
    expect(failed).toEqual({ kind: "failed", requestId, reason: "unavailable" });

    // Restart: a fresh registry over the same directory sees only what is durable.
    const reloaded = new SideChatSidecarStore(root);
    await reloaded.hydrate();
    const healthy = sideChatThreads({ minted: crashing.minted });
    const second = new ThreadMentionService({
      directories: [directory("chat", [thread(chatThreadId)])],
      sidecars: reloaded,
      sideChatThreads: healthy,
      clock: () => "2026-08-14T11:00:00.000Z",
      uuid: sequentialUuid(50),
    });

    const opened = await second.execute(
      { kind: "open-side-chat", requestId, sourceThreadId: chatThreadId },
      { windowId },
    );

    if (opened.kind !== "side-chat-opened") throw new Error("expected side chat result");
    expect([...healthy.minted.keys()]).toEqual([String(opened.sidecar.sidecarThreadId)]);
    expect(reloaded.hiddenThreadIds()).toEqual(new Set([String(opened.sidecar.sidecarThreadId)]));
  });

  it("rejects an unknown command shape", async () => {
    const { service } = createService([directory("chat", [thread(chatThreadId)])]);

    await expect(
      service.execute({ kind: "steer-source-thread", requestId }, { windowId }),
    ).rejects.toThrow();
  });
});

describe("createChatThreadMentionDirectory", () => {
  const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000101");

  function chatView() {
    return {
      turns: [
        {
          id: "turn-1",
          userMessageRef: { contentId: "c1" },
          createdAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
          attempts: [
            {
              outcome: "completed",
              responseRefs: [{ contentId: "c2" }],
              updatedAt: "2026-08-14T10:00:01.000Z" as UtcTimestamp,
            },
          ],
        },
      ],
      contents: [
        { contentId: "c1", body: "what changed in /src/app.ts?" },
        { contentId: "c2", body: "" },
      ],
    };
  }

  /** One turn whose only attempt ended with `outcome` after emitting text. */
  function turnEndedWith(outcome: string) {
    return {
      turns: [
        {
          id: "turn-1",
          userMessageRef: { contentId: "c1" },
          createdAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
          attempts: [
            {
              outcome,
              responseRefs: [{ contentId: "c2" }],
              updatedAt: "2026-08-14T10:00:01.000Z" as UtcTimestamp,
            },
          ],
        },
      ],
      contents: [
        { contentId: "c1", body: "summarize the release" },
        { contentId: "c2", body: "The release includes" },
      ],
    };
  }

  it("lists active chat threads and labels their placement from the server", async () => {
    const chat = createChatThreadMentionDirectory({
      bootstrap: async () => ({
        threads: [
          {
            id: threadId,
            title: "Release notes",
            lifecycle: "active",
            updatedAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
            projectId: "project-1",
            providerInstanceId,
            modelId: "gpt-5" as never,
          },
          {
            id: decodeChatThreadId("00000000-0000-4000-8000-000000000102"),
            title: "Archived",
            lifecycle: "archived",
            updatedAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
            providerInstanceId,
            modelId: "gpt-5" as never,
          },
        ],
      }),
      read: () => chatView(),
      projectLabel: (id) => (id === "project-1" ? "Launch" : undefined),
    });

    const threads = await chat.listOpenable(windowId);

    expect(threads).toHaveLength(1);
    expect(threads[0]!.placement).toEqual({ kind: "project", label: "Launch" });
  });

  it("keeps ordinary prose with slashes intact and skips empty content", async () => {
    const chat = createChatThreadMentionDirectory({
      bootstrap: async () => ({ threads: [] }),
      read: () => chatView(),
    });

    const transcript = await chat.readTranscript(windowId, chatThreadId);

    expect(transcript).toEqual([
      {
        role: "user",
        text: "what changed in /src/app.ts?",
        occurredAt: "2026-08-14T10:00:00.000Z",
      },
    ]);
  });

  it("mentions the active conversation, never a superseded turn and its reply", async () => {
    const chat = createChatThreadMentionDirectory({
      bootstrap: async () => ({ threads: [] }),
      read: () => ({
        turns: [
          {
            id: "turn-1",
            userMessageRef: { contentId: "c1" },
            createdAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
            attempts: [
              {
                outcome: "completed",
                responseRefs: [{ contentId: "c2" }],
                updatedAt: "2026-08-14T10:00:01.000Z" as UtcTimestamp,
              },
            ],
          },
          {
            id: "turn-2",
            supersedes: "turn-1",
            userMessageRef: { contentId: "c3" },
            createdAt: "2026-08-14T10:05:00.000Z" as UtcTimestamp,
            attempts: [
              {
                outcome: "completed",
                responseRefs: [{ contentId: "c4" }],
                updatedAt: "2026-08-14T10:05:01.000Z" as UtcTimestamp,
              },
            ],
          },
        ],
        contents: [
          { contentId: "c1", body: "ship the preview on Friday" },
          { contentId: "c2", body: "Friday works" },
          { contentId: "c3", body: "ship the preview on Monday" },
          { contentId: "c4", body: "Monday works" },
        ],
      }),
    });

    const transcript = await chat.readTranscript(windowId, chatThreadId);

    expect(transcript?.map((line) => line.text)).toEqual([
      "ship the preview on Monday",
      "Monday works",
    ]);
  });

  it.each(["failed", "interrupted", "cancelled", "waiting", "streaming", "queued"])(
    "keeps the prompt but not the partial text of an attempt that %s",
    async (outcome) => {
      const chat = createChatThreadMentionDirectory({
        bootstrap: async () => ({ threads: [] }),
        read: () => turnEndedWith(outcome),
      });

      const transcript = await chat.readTranscript(windowId, chatThreadId);

      // The prompt still stands: the user asked it, and the Work and Code
      // directories admit an unfinished turn's prompt the same way.
      expect(transcript).toEqual([
        {
          role: "user",
          text: "summarize the release",
          occurredAt: "2026-08-14T10:00:00.000Z",
        },
      ]);
    },
  );

  it("quotes the answer a retry produced, not the abandoned partial before it", async () => {
    const chat = createChatThreadMentionDirectory({
      bootstrap: async () => ({ threads: [] }),
      read: () => ({
        turns: [
          {
            id: "turn-1",
            userMessageRef: { contentId: "c1" },
            createdAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
            attempts: [
              {
                outcome: "failed",
                responseRefs: [{ contentId: "c2" }],
                updatedAt: "2026-08-14T10:00:01.000Z" as UtcTimestamp,
              },
              {
                outcome: "completed",
                responseRefs: [{ contentId: "c3" }],
                updatedAt: "2026-08-14T10:00:09.000Z" as UtcTimestamp,
              },
            ],
          },
        ],
        contents: [
          { contentId: "c1", body: "summarize the release" },
          { contentId: "c2", body: "The release inclu" },
          { contentId: "c3", body: "The release ships the preview." },
        ],
      }),
    });

    const transcript = await chat.readTranscript(windowId, chatThreadId);

    expect(transcript?.map((line) => [line.role, line.text])).toEqual([
      ["user", "summarize the release"],
      ["assistant", "The release ships the preview."],
    ]);
  });

  it("returns undefined when the Chat read refuses the thread", async () => {
    const chat = createChatThreadMentionDirectory({
      bootstrap: async () => ({ threads: [] }),
      read: () => {
        throw new Error("not found");
      },
    });

    expect(await chat.readTranscript(windowId, chatThreadId)).toBeUndefined();
  });
});

describe("createChatSideChatThreadFactory", () => {
  const claimedThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000201");

  it("creates the claimed Chat thread and hands it the inherited selection", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "thread-created",
        thread: { id: String(claimedThreadId), version: 1 },
      })
      .mockResolvedValueOnce({ kind: "thread-updated" });
    const factory = createChatSideChatThreadFactory({ execute, read: () => undefined });

    const created = await factory.ensure({
      threadId: claimedThreadId,
      title: "Side Chat about Release notes",
      providerInstanceId,
      modelId: "gpt-5" as never,
    });

    expect(created).toBe(true);
    expect(execute).toHaveBeenNthCalledWith(1, {
      kind: "create-chat-thread",
      threadId: claimedThreadId,
      title: "Side Chat about Release notes",
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      kind: "change-chat-provider",
      threadId: claimedThreadId,
      expectedVersion: 1,
      providerInstanceId,
      modelId: "gpt-5",
    });
  });

  it("skips the provider handoff when the source had no selection", async () => {
    const execute = vi.fn().mockResolvedValue({
      kind: "thread-created",
      thread: { id: String(claimedThreadId), version: 1 },
    });
    const factory = createChatSideChatThreadFactory({ execute, read: () => undefined });

    await factory.ensure({ threadId: claimedThreadId, title: "Side Chat about this thread" });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("leaves a claim whose thread Chat already holds alone", async () => {
    const execute = vi.fn();
    const factory = createChatSideChatThreadFactory({
      execute,
      read: () => ({ thread: { id: String(claimedThreadId) } }),
    });

    const created = await factory.ensure({
      threadId: claimedThreadId,
      title: "Side Chat about Release notes",
    });

    expect(created).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("createWorkThreadMentionDirectory", () => {
  const openable = decodeWorkThreadId("00000000-0000-4000-8000-000000000301");
  const archivedThreadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000302");

  function workThread(overrides: Record<string, unknown> = {}) {
    return {
      id: openable,
      title: "Launch brief",
      lifecycle: "active",
      projectId: "project-1" as never,
      updatedAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
      providerInstanceId,
      modelId: "gpt-5" as never,
      ...overrides,
    };
  }

  it("lists exactly the Work threads this window's own bootstrap returned", async () => {
    const bootstrap = vi.fn(async () => ({
      threads: [workThread(), workThread({ id: archivedThreadId, lifecycle: "archived" })],
    }));
    const work = createWorkThreadMentionDirectory({
      bootstrap,
      transcript: async () => ({ turns: [] }),
      projectLabel: (id) => (id === "project-1" ? "Launch" : undefined),
    });

    const threads = await work.listOpenable(windowId);

    // The Open check is the Work bootstrap's, run on this window's own
    // principal: a thread its Project filter dropped can never be mentioned.
    expect(bootstrap).toHaveBeenCalledWith(windowId);
    expect(threads.map((thread) => String(thread.threadId))).toEqual([String(openable)]);
    expect(threads[0]!.mode).toBe("work");
    expect(threads[0]!.placement).toEqual({ kind: "project", label: "Launch" });
  });

  it("returns undefined when the Work transcript read refuses the thread", async () => {
    const work = createWorkThreadMentionDirectory({
      bootstrap: async () => ({ threads: [] }),
      transcript: async () => {
        throw new Error("Work thread is unavailable for this window.");
      },
    });

    expect(
      await work.readTranscript(windowId, decodeMentionableThreadId(String(openable))),
    ).toBeUndefined();
  });

  it("quotes an answered Work exchange and never an unfinished turn's partial output", async () => {
    const work = createWorkThreadMentionDirectory({
      bootstrap: async () => ({ threads: [] }),
      transcript: async () => ({
        turns: [
          {
            status: "completed",
            transcript: [
              { role: "user" as const, text: "draft the launch brief" },
              { role: "assistant" as const, text: "Drafted it.", status: "completed" },
            ],
            acceptedAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
            updatedAt: "2026-08-14T10:00:05.000Z" as UtcTimestamp,
          },
          {
            status: "failed",
            transcript: [
              { role: "user" as const, text: "now add the pricing table" },
              { role: "assistant" as const, text: "Half a tab", status: "failed" },
            ],
            acceptedAt: "2026-08-14T10:01:00.000Z" as UtcTimestamp,
            updatedAt: "2026-08-14T10:01:05.000Z" as UtcTimestamp,
          },
        ],
      }),
    });

    const transcript = await work.readTranscript(
      windowId,
      decodeMentionableThreadId(String(openable)),
    );

    expect(transcript).toEqual([
      { role: "user", text: "draft the launch brief", occurredAt: "2026-08-14T10:00:00.000Z" },
      { role: "assistant", text: "Drafted it.", occurredAt: "2026-08-14T10:00:05.000Z" },
      { role: "user", text: "now add the pricing table", occurredAt: "2026-08-14T10:01:00.000Z" },
    ]);
  });
});

describe("createCodeThreadMentionDirectory", () => {
  const openable = decodeCodeThreadId("00000000-0000-4000-8000-000000000401");
  const archivedThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000402");
  const operationId = "00000000-0000-4000-8000-000000000411" as never;

  function codeThread(overrides: Record<string, unknown> = {}) {
    return {
      id: openable,
      title: "Fix the picker",
      lifecycle: "active",
      projectId: "project-2" as never,
      updatedAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
      providerInstanceId,
      modelId: "gpt-5" as never,
      ...overrides,
    };
  }

  function evidence(bodies: Record<string, string>) {
    return vi.fn(async (_window: unknown, _thread: unknown, _operation: unknown, id: string) => {
      const body = bodies[id];
      if (body === undefined) throw new Error("Code evidence is unavailable.");
      return { bytes: new TextEncoder().encode(body) };
    });
  }

  it("lists exactly the Code threads this window's own bootstrap returned", async () => {
    const bootstrap = vi.fn(async () => ({
      threads: [codeThread(), codeThread({ id: archivedThreadId, lifecycle: "archived" })],
    }));
    const code = createCodeThreadMentionDirectory({
      bootstrap,
      conversation: async () => ({ turns: [], nextCursor: 0, hasMore: false }),
      readEvidence: evidence({}),
      projectLabel: (id) => (id === "project-2" ? "Octant" : undefined),
    });

    const threads = await code.listOpenable(windowId);

    // `bootstrap` is the only Code listing that runs the per-Project access
    // check; reading the raw thread projection would widen what this window
    // may see.
    expect(bootstrap).toHaveBeenCalledWith(windowId);
    expect(threads.map((thread) => String(thread.threadId))).toEqual([String(openable)]);
    expect(threads[0]!.mode).toBe("code");
    expect(threads[0]!.placement).toEqual({ kind: "project", label: "Octant" });
  });

  it("returns undefined when the Code conversation read refuses the thread", async () => {
    const code = createCodeThreadMentionDirectory({
      bootstrap: async () => ({ threads: [] }),
      conversation: async () => {
        throw new Error("unauthorized");
      },
      readEvidence: evidence({}),
    });

    expect(
      await code.readTranscript(windowId, decodeMentionableThreadId(String(openable))),
    ).toBeUndefined();
  });

  it("quotes an answered Code exchange and never an unfinished turn's partial output", async () => {
    const conversation = vi.fn(
      async (_window: unknown, _thread: unknown, afterCursor: number, _limit: number) =>
        afterCursor === 0
          ? {
              turns: [
                {
                  operationId,
                  prompt: { contentId: "p1" },
                  assistant: [{ contentId: "a1" }, { contentId: "a2" }],
                  status: "completed",
                  startedAt: "2026-08-14T10:00:00.000Z" as UtcTimestamp,
                  updatedAt: "2026-08-14T10:00:05.000Z" as UtcTimestamp,
                },
              ],
              nextCursor: 7,
              hasMore: true,
            }
          : {
              turns: [
                {
                  operationId,
                  prompt: { contentId: "p2" },
                  assistant: [{ contentId: "a3" }],
                  status: "incomplete",
                  startedAt: "2026-08-14T10:01:00.000Z" as UtcTimestamp,
                  updatedAt: "2026-08-14T10:01:05.000Z" as UtcTimestamp,
                },
              ],
              nextCursor: 9,
              hasMore: false,
            },
    );
    const readEvidence = evidence({
      p1: "why is the picker empty?",
      a1: "Because the directory ",
      a2: "was never registered.",
      p2: "fix it",
      a3: "partial stream",
    });
    const code = createCodeThreadMentionDirectory({
      bootstrap: async () => ({ threads: [] }),
      conversation,
      readEvidence,
    });

    const transcript = await code.readTranscript(
      windowId,
      decodeMentionableThreadId(String(openable)),
    );

    expect(transcript).toEqual([
      { role: "user", text: "why is the picker empty?", occurredAt: "2026-08-14T10:00:00.000Z" },
      {
        role: "assistant",
        text: "Because the directory was never registered.",
        occurredAt: "2026-08-14T10:00:05.000Z",
      },
      { role: "user", text: "fix it", occurredAt: "2026-08-14T10:01:00.000Z" },
    ]);
    // A turn that never completed contributes no assistant answer, so its
    // evidence is never even read.
    expect(readEvidence).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "a3",
    );
  });
});
