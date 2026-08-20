import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  decodeMentionableThreadId,
  decodeThreadMentionCommand,
  decodeThreadMentionCommandResult,
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  MAX_THREAD_MENTION_CANDIDATES,
  MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES,
  type ChatThreadId,
  type CodeOperationId,
  type CodeThreadId,
  type WorkThreadId,
  type MentionableThreadId,
  type OctantMode,
  type ProviderInstanceId,
  type ProviderModelId,
  type ResolvedThreadMention,
  type SideChatSidecar,
  type ThreadMentionCandidate,
  type ThreadMentionCommand,
  type ThreadMentionCommandResult,
  type ThreadMentionPlacement,
  type ThreadMentionTranscriptEntry,
  type UnavailableThreadMention,
  UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import {
  activeChatTurns,
  chatAttemptAnswered,
  boundThreadMentionTranscript,
  rankThreadMentionCandidates,
  sideChatTitle,
} from "@octant/domain";
import { Schema } from "effect";
import type { SideChatSidecarStore } from "./sideChatSidecarStore";

/**
 * One thread the current principal can already Open, as its owning mode's
 * service reports it. Provider/model ride along so a new Side Chat sidecar can
 * inherit the source thread's selection without the renderer
 * choosing one.
 */
export interface ThreadMentionDirectoryThread {
  readonly threadId: MentionableThreadId;
  readonly mode: OctantMode;
  readonly title: string;
  readonly placement: ThreadMentionPlacement;
  readonly updatedAt: UtcTimestamp;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly modelId?: ProviderModelId;
}

/**
 * Per-mode read port for the mention surface.
 *
 * A mention is not a new permission: it resolves exactly the threads a mode
 * already lets this principal Open, and reads their transcript through the
 * same service that would have served an Open. Implementations must fail
 * closed — omit the thread, or return `undefined` — whenever Open would have
 * been refused, so an unopenable thread never leaks its title or content.
 */
export interface ThreadMentionDirectory {
  readonly mode: OctantMode;
  listOpenable(windowId: WindowId): Promise<ReadonlyArray<ThreadMentionDirectoryThread>>;
  readTranscript(
    windowId: WindowId,
    threadId: MentionableThreadId,
  ): Promise<ReadonlyArray<ThreadMentionTranscriptEntry> | undefined>;
}

/**
 * Mints the Chat-mode sidecar thread for a Side Chat. Kept a port so the
 * mention service never reaches into Chat's command surface directly, and so
 * the sidecar is always an ordinary Chat thread rather than a new domain
 * thread type.
 *
 * The thread id is the caller's, not the port's: the registry claims the link
 * before Chat commits anything, so the port is asked to make *that* id exist
 * carrying the supplied selection. It must therefore be idempotent — neither a
 * thread that already exists nor a selection Chat already holds is touched
 * again — because an unfinished claim is finished by the next open.
 *
 * It resolves only once both halves hold. A thread that exists without the
 * supplied selection is not a usable sidecar, so the port throws rather than
 * reporting an open the caller would call complete.
 */
export interface SideChatThreadFactory {
  /** Resolves `true` when this call is what committed the thread. */
  ensure(input: {
    readonly threadId: ChatThreadId;
    readonly title: string;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly modelId?: ProviderModelId;
  }): Promise<boolean>;
}

export interface ThreadMentionServiceOptions {
  readonly directories: ReadonlyArray<ThreadMentionDirectory>;
  readonly sidecars: SideChatSidecarStore;
  readonly sideChatThreads: SideChatThreadFactory;
  readonly clock: () => string;
  /** Mints the sidecar thread id the registry claims before Chat is touched. */
  readonly uuid: () => string;
}

/**
 * Authoritative thread-mention and Side Chat surface.
 *
 * Every command re-derives the openable set from the mode directories on the
 * request's own principal; nothing is trusted from the renderer beyond opaque
 * thread ids. The service is strictly read-plus-sidecar: it can search, it can
 * read a bounded transcript window, and it can get-or-create one Chat sidecar.
 * It has no path that appends to, steers, approves, or otherwise mutates a
 * mentioned or source thread.
 */
export class ThreadMentionService {
  readonly #directories: ReadonlyArray<ThreadMentionDirectory>;
  readonly #sidecars: SideChatSidecarStore;
  readonly #sideChatThreads: SideChatThreadFactory;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  /**
   * One in-flight Side Chat admission per source thread. The claim and the
   * Chat create are two awaits apart, so without this a second concurrent open
   * races the first through both — duplicating the create for the same claimed
   * id and answering the caller from whichever lost.
   */
  readonly #openingSideChats = new Map<string, Promise<SideChatAdmission>>();

  constructor(options: ThreadMentionServiceOptions) {
    this.#directories = options.directories;
    this.#sidecars = options.sidecars;
    this.#sideChatThreads = options.sideChatThreads;
    this.#clock = options.clock;
    this.#uuid = options.uuid;
  }

  async execute(
    input: unknown,
    context: { readonly windowId: WindowId },
  ): Promise<ThreadMentionCommandResult> {
    const command = decodeThreadMentionCommand(input);
    switch (command.kind) {
      case "search-mentions":
        return decodeThreadMentionCommandResult({
          kind: "mentions-searched",
          requestId: command.requestId,
          candidates: await this.#search(context.windowId, command.query),
        });
      case "resolve-mentions":
        return decodeThreadMentionCommandResult({
          kind: "mentions-resolved",
          requestId: command.requestId,
          ...(await this.#resolve(context.windowId, command.threadIds)),
        });
      case "open-side-chat":
        return await this.#openSideChat(context.windowId, command);
    }
  }

  async #openable(windowId: WindowId): Promise<ReadonlyMap<string, ThreadMentionDirectoryThread>> {
    const openable = new Map<string, ThreadMentionDirectoryThread>();
    const hidden = this.#sidecars.hiddenThreadIds();
    for (const directory of this.#directories) {
      let threads: ReadonlyArray<ThreadMentionDirectoryThread>;
      try {
        threads = await directory.listOpenable(windowId);
      } catch {
        // A mode whose service is unavailable contributes nothing rather than
        // failing the whole picker; the other modes stay mentionable.
        continue;
      }
      for (const thread of threads) {
        // A Side Chat sidecar is not itself mentionable: it is a lane about
        // another thread, and listing it would turn Side Chat into a second
        // thread inbox.
        if (hidden.has(String(thread.threadId))) continue;
        openable.set(String(thread.threadId), thread);
      }
    }
    return openable;
  }

  async #search(windowId: WindowId, query: string): Promise<ReadonlyArray<ThreadMentionCandidate>> {
    const openable = [...(await this.#openable(windowId)).values()].sort((left, right) =>
      left.updatedAt === right.updatedAt
        ? left.title.localeCompare(right.title)
        : left.updatedAt < right.updatedAt
          ? 1
          : -1,
    );
    const candidates = openable.map((thread) => {
      const sidecar = this.#sidecars.find(thread.threadId);
      return {
        threadId: thread.threadId,
        mode: thread.mode,
        title: thread.title,
        placement: thread.placement,
        updatedAt: thread.updatedAt,
        ...(sidecar === undefined ? {} : { sideChatThreadId: sidecar.sidecarThreadId }),
      } satisfies ThreadMentionCandidate;
    });
    return rankThreadMentionCandidates(candidates, query, MAX_THREAD_MENTION_CANDIDATES);
  }

  async #resolve(
    windowId: WindowId,
    threadIds: ReadonlyArray<MentionableThreadId>,
  ): Promise<{
    readonly mentions: ReadonlyArray<ResolvedThreadMention>;
    readonly unavailable: ReadonlyArray<UnavailableThreadMention>;
  }> {
    const openable = await this.#openable(windowId);
    const mentions: ResolvedThreadMention[] = [];
    const unavailable: UnavailableThreadMention[] = [];
    for (const threadId of threadIds) {
      const thread = openable.get(String(threadId));
      if (thread === undefined) {
        // Fail closed: an Open the principal would be refused yields only the
        // opaque id back, never a title, mode, or placement.
        unavailable.push({ threadId, reason: "unauthorized" });
        continue;
      }
      const directory = this.#directories.find((candidate) => candidate.mode === thread.mode);
      if (directory === undefined) {
        unavailable.push({ threadId, reason: "unsupported-mode" });
        continue;
      }
      let entries: ReadonlyArray<ThreadMentionTranscriptEntry> | undefined;
      try {
        entries = await directory.readTranscript(windowId, threadId);
      } catch {
        entries = undefined;
      }
      if (entries === undefined) {
        unavailable.push({ threadId, reason: "not-found" });
        continue;
      }
      const bounded = boundThreadMentionTranscript(entries);
      mentions.push({
        threadId: thread.threadId,
        mode: thread.mode,
        title: thread.title,
        placement: thread.placement,
        transcript: bounded.transcript,
        truncated: bounded.truncated,
      });
    }
    return { mentions, unavailable };
  }

  async #openSideChat(
    windowId: WindowId,
    command: Extract<ThreadMentionCommand, { kind: "open-side-chat" }>,
  ): Promise<ThreadMentionCommandResult> {
    const openable = await this.#openable(windowId);
    const source = openable.get(String(command.sourceThreadId));
    if (source === undefined) {
      return { kind: "failed", requestId: command.requestId, reason: "unauthorized" };
    }
    // Even an already-linked source goes through the admission below rather
    // than returning here: a claim whose Chat thread was never created must be
    // finished, and only the admission path can see that.
    //
    // Reading the map and writing it are synchronous, so exactly one request
    // per source thread becomes the admitted opener; the rest join it and
    // receive the sidecar it committed. The caller asked for *the* Side Chat,
    // so a joiner is served the winner rather than an error.
    const key = String(source.threadId);
    const joined = this.#openingSideChats.get(key);
    if (joined !== undefined) {
      try {
        return {
          kind: "side-chat-opened",
          requestId: command.requestId,
          sidecar: (await joined).sidecar,
          created: false,
        };
      } catch {
        return { kind: "failed", requestId: command.requestId, reason: "unavailable" };
      }
    }
    const admission = this.#admitSideChat(source);
    this.#openingSideChats.set(key, admission);
    let outcome: SideChatAdmission;
    try {
      outcome = await admission;
    } catch {
      return { kind: "failed", requestId: command.requestId, reason: "unavailable" };
    } finally {
      this.#openingSideChats.delete(key);
    }
    return {
      kind: "side-chat-opened",
      requestId: command.requestId,
      sidecar: outcome.sidecar,
      created: outcome.created,
    };
  }

  /**
   * Claim the sidecar link first, then make Chat hold the thread it names.
   *
   * Creating first committed a Chat thread that the registry — and therefore
   * the hidden-thread seam reading it — might never name: a link write that
   * failed left that thread durable, unlinked, and visible in Recents, and
   * every retry minted another one, because no winning link existed to reuse.
   * Claiming first closes that window the way the Navigator conversation does
   * (`navigatorAssistantService.#claimConversation`/`#openConversation`):
   * nothing reaches Chat until the durable claim holds, and a claim whose
   * thread was never created is finished by the next open, because the
   * registry names the exact id to create.
   *
   * Compensating deletion was rejected for the same reason it was there: the
   * failure being compensated is a registry write failure, so the compensating
   * delete goes to a store that is already refusing writes and would most
   * likely fail identically — and it would journal a create/delete lifecycle
   * for a thread the user never saw.
   */
  async #admitSideChat(source: ThreadMentionDirectoryThread): Promise<SideChatAdmission> {
    const title = sideChatTitle(source.title);
    // An existing link always wins, so a claim is only ever minted once per
    // source thread; the discarded id named no thread, because nothing was
    // created for it.
    const claimed = await this.#sidecars.record({
      sourceThreadId: source.threadId,
      sourceMode: source.mode,
      sidecarThreadId: decodeChatThreadId(this.#uuid()),
      title,
      createdAt: decodeUtcTimestamp(this.#clock()),
    });
    // Inheritance is applied only while the claim is unfinished. A settled
    // sidecar keeps whatever selection it now holds: the user may
    // change it after the first open, and the source thread may move to a
    // different provider later, and neither may be overwritten from here.
    const pending = this.#sidecars.inheritancePending(claimed.sourceThreadId);
    // The sidecar is ordinary Chat. It inherits only the source thread's
    // provider/model selection — never its Work or Code filesystem,
    // shell, Git, or worktree authority.
    //
    // A throw leaves the claim unfinished: every sidecar turn carries the
    // source thread's transcript, so a sidecar that never inherited the source
    // selection would transmit that transcript to the Chat default — a
    // provider the user never chose for this source thread. The open reports
    // unavailable instead, and the claim is finished by a later open.
    const created = await this.#sideChatThreads.ensure({
      threadId: claimed.sidecarThreadId,
      title: claimed.title,
      ...(pending && source.providerInstanceId !== undefined
        ? { providerInstanceId: source.providerInstanceId }
        : {}),
      ...(pending && source.modelId !== undefined ? { modelId: source.modelId } : {}),
    });
    if (pending) await this.#sidecars.confirmInheritance(claimed.sourceThreadId);
    return { sidecar: claimed, created };
  }
}

interface SideChatAdmission {
  readonly sidecar: SideChatSidecar;
  readonly created: boolean;
}

/**
 * Chat-mode directory over the existing Chat service. Openability is exactly
 * what Chat's own bootstrap and thread read allow: a thread the read refuses
 * is simply absent, so the mention surface adds no authority of its own.
 */
export function createChatThreadMentionDirectory(input: {
  readonly bootstrap: () => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: ChatThreadId;
      readonly title: string;
      readonly lifecycle: string;
      readonly updatedAt: UtcTimestamp;
      readonly projectId?: unknown;
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
    }>;
  }>;
  readonly read: (threadId: ChatThreadId) => {
    readonly turns: ReadonlyArray<{
      readonly id: string;
      readonly supersedes?: string | undefined;
      readonly userMessageRef: { readonly contentId: unknown };
      readonly createdAt: UtcTimestamp;
      readonly attempts: ReadonlyArray<{
        readonly outcome: string;
        readonly responseRefs: ReadonlyArray<{ readonly contentId: unknown }>;
        readonly updatedAt: UtcTimestamp;
      }>;
    }>;
    readonly contents: ReadonlyArray<{ readonly contentId: unknown; readonly body: string }>;
  };
  readonly projectLabel?: (projectId: string) => string | undefined;
}): ThreadMentionDirectory {
  return {
    mode: "chat",
    async listOpenable() {
      const bootstrap = await input.bootstrap();
      return bootstrap.threads
        .filter((thread) => thread.lifecycle === "active")
        .map((thread) => ({
          threadId: decodeMentionableThreadId(String(thread.id)),
          mode: "chat" as const,
          title: thread.title,
          placement: threadPlacement(thread.projectId, input.projectLabel),
          updatedAt: thread.updatedAt,
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
        }));
    },
    async readTranscript(_windowId, threadId) {
      let view: ReturnType<typeof input.read>;
      try {
        view = input.read(decodeChatThreadId(String(threadId)));
      } catch {
        return undefined;
      }
      const bodies = new Map(
        view.contents.map((content) => [String(content.contentId), content.body]),
      );
      const entries: ThreadMentionTranscriptEntry[] = [];
      // A mention hands a second model the conversation as it now stands. An
      // edited turn stays journaled but is no longer part of that conversation,
      // so the abandoned branch must not ride along beside its replacement.
      for (const turn of activeChatTurns(view.turns)) {
        const prompt = bodies.get(String(turn.userMessageRef.contentId));
        if (prompt !== undefined && prompt.trim().length > 0) {
          entries.push({ role: "user", text: truncateEntry(prompt), occurredAt: turn.createdAt });
        }
        for (const attempt of turn.attempts) {
          // Same honesty rule the Work and Code directories below apply: a
          // mention hands the conversation to another model, and after a retry
          // an abandoned fragment would reach it side by side with the answer,
          // indistinguishable. The transcript entry carries no way to mark text
          // as partial, so an unanswered attempt contributes nothing rather
          // than an unlabelled fragment; the prompt still rides along, as it
          // does for an unfinished Work or Code turn.
          if (!chatAttemptAnswered(attempt)) continue;
          for (const reference of attempt.responseRefs) {
            const response = bodies.get(String(reference.contentId));
            if (response === undefined || response.trim().length === 0) continue;
            entries.push({
              role: "assistant",
              text: truncateEntry(response),
              occurredAt: attempt.updatedAt,
            });
          }
        }
      }
      return entries;
    },
  };
}

/**
 * Side Chat sidecar factory over the existing Chat command surface. The
 * sidecar is created as an ordinary unfiled Chat thread at the id the registry
 * already claimed, and then, when a selection was supplied, handed that
 * provider/model through the same `change-chat-provider` command a user would
 * issue.
 *
 * `ensure` guarantees both halves or throws. A thread created on the Chat
 * default because the source provider is disabled or removed is not a working
 * sidecar: the sidecar's turns carry the source thread's transcript, so its
 * selection decides where that transcript is transmitted, and the source pair
 * changes only by explicit user choice. The caller keeps the claim
 * unfinished on a throw, so the half-made thread stays hidden and unusable
 * until a later open completes it.
 *
 * Both halves are idempotent by id: an existing thread is not recreated, and a
 * selection Chat already holds is not re-applied, so finishing an unfinished
 * claim costs only the commands still missing. The caller supplies the
 * selection only while the claim is unfinished, so this never overwrites a
 * choice the user made on a sidecar that already opened.
 */
export function createChatSideChatThreadFactory(input: {
  readonly execute: (command: unknown) => Promise<unknown>;
  /** The thread as Chat would open it, or `undefined` when it does not exist. */
  readonly read: (threadId: ChatThreadId) => unknown;
}): SideChatThreadFactory {
  return {
    async ensure({ threadId, title, providerInstanceId, modelId }) {
      let thread = chatThreadFacts(input.read(threadId));
      let created = false;
      if (thread === undefined) {
        try {
          thread = chatThreadFacts(
            await input.execute({ kind: "create-chat-thread", threadId, title }),
          );
          created = true;
        } catch (error) {
          // A create that lost to another writer of the same claim is not a
          // second sidecar: the claim names one thread, so adopt it.
          thread = chatThreadFacts(input.read(threadId));
          if (thread === undefined) throw error;
        }
      }
      if (providerInstanceId === undefined || modelId === undefined) return created;
      if (
        String(thread?.providerInstanceId) === String(providerInstanceId) &&
        String(thread?.modelId) === String(modelId)
      ) {
        return created;
      }
      await input.execute({
        kind: "change-chat-provider",
        threadId,
        expectedVersion: thread?.version,
        providerInstanceId,
        modelId,
      });
      return created;
    },
  };
}

/**
 * The thread facts both a Chat read and a Chat create result carry, or
 * `undefined` when neither holds a thread.
 */
function chatThreadFacts(value: unknown):
  | {
      readonly version?: unknown;
      readonly providerInstanceId?: unknown;
      readonly modelId?: unknown;
    }
  | undefined {
  return (
    value as {
      readonly thread?: {
        readonly version?: unknown;
        readonly providerInstanceId?: unknown;
        readonly modelId?: unknown;
      };
    }
  )?.thread;
}

/**
 * Work-mode directory over the existing Work thread and turn services.
 *
 * Openability is exactly what Work's own bootstrap allows: it re-derives the
 * accessible Work Projects for this window and returns only threads filed
 * under them, so the mention surface can never widen a window past the
 * Projects it may already open. Reading the raw thread projection here would
 * skip that Project check and leak another Project's thread titles.
 */
export function createWorkThreadMentionDirectory(input: {
  readonly bootstrap: (windowId: WindowId) => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: WorkThreadId;
      readonly title: string;
      readonly lifecycle: string;
      readonly projectId: unknown;
      readonly updatedAt: UtcTimestamp;
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
    }>;
  }>;
  /**
   * The same thread transcript an Open would serve. It re-runs the Work
   * bootstrap on this window and throws when the thread is not among its
   * threads, which is why a refusal here is answered with `undefined`.
   */
  readonly transcript: (
    windowId: WindowId,
    threadId: WorkThreadId,
  ) => Promise<{
    readonly turns: ReadonlyArray<{
      readonly status: string;
      readonly transcript: ReadonlyArray<{
        readonly role: "user" | "assistant";
        readonly text: string;
      }>;
      readonly acceptedAt: UtcTimestamp;
      readonly updatedAt: UtcTimestamp;
    }>;
  }>;
  readonly projectLabel?: (projectId: string) => string | undefined;
}): ThreadMentionDirectory {
  return {
    mode: "work",
    async listOpenable(windowId) {
      const bootstrap = await input.bootstrap(windowId);
      return bootstrap.threads
        .filter((thread) => thread.lifecycle === "active")
        .map((thread) => ({
          threadId: decodeMentionableThreadId(String(thread.id)),
          mode: "work" as const,
          title: thread.title,
          placement: threadPlacement(thread.projectId, input.projectLabel),
          updatedAt: thread.updatedAt,
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
        }));
    },
    async readTranscript(windowId, threadId) {
      let view: Awaited<ReturnType<typeof input.transcript>>;
      try {
        view = await input.transcript(windowId, decodeWorkThreadId(String(threadId)));
      } catch {
        return undefined;
      }
      const entries: ThreadMentionTranscriptEntry[] = [];
      for (const turn of view.turns) {
        for (const line of turn.transcript) {
          // A turn that has not completed has no answer yet: its text is a
          // partial stream, an interrupted attempt, or an empty placeholder.
          // Quoting that beside the prompt would tell another model the work
          // was answered, so only the prompt of an unfinished turn rides along.
          if (line.role === "assistant" && turn.status !== "completed") continue;
          const text = line.text.trim();
          if (text.length === 0) continue;
          entries.push({
            role: line.role,
            text: truncateEntry(text),
            occurredAt: line.role === "user" ? turn.acceptedAt : turn.updatedAt,
          });
        }
      }
      return entries;
    },
  };
}

/**
 * Code-mode directory over the existing Code service and its durable
 * conversation evidence.
 *
 * Openability is exactly what Code's own bootstrap allows: it filters threads
 * by the window's per-Project access, so a repository the principal cannot
 * open never appears. Transcript text is read back through the same
 * operation-scoped evidence read the Code workspace itself uses, which
 * re-authorizes the thread on every call.
 */
export function createCodeThreadMentionDirectory(input: {
  readonly bootstrap: (windowId: WindowId) => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: CodeThreadId;
      readonly title: string;
      readonly lifecycle: string;
      readonly projectId: unknown;
      readonly updatedAt: UtcTimestamp;
      readonly providerInstanceId: ProviderInstanceId;
      readonly modelId: ProviderModelId;
    }>;
  }>;
  readonly conversation: (
    windowId: WindowId,
    threadId: CodeThreadId,
    afterCursor: number,
    limit: number,
  ) => Promise<{
    readonly turns: ReadonlyArray<{
      readonly operationId: CodeOperationId;
      readonly prompt: { readonly contentId: string };
      readonly assistant: ReadonlyArray<{ readonly contentId: string }>;
      readonly status: string;
      readonly startedAt: UtcTimestamp;
      readonly updatedAt: UtcTimestamp;
    }>;
    readonly nextCursor: number;
    readonly hasMore: boolean;
  }>;
  readonly readEvidence: (
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    contentId: string,
  ) => Promise<{ readonly bytes: Uint8Array }>;
  readonly projectLabel?: (projectId: string) => string | undefined;
}): ThreadMentionDirectory {
  return {
    mode: "code",
    async listOpenable(windowId) {
      const bootstrap = await input.bootstrap(windowId);
      return bootstrap.threads
        .filter((thread) => thread.lifecycle !== "archived")
        .map((thread) => ({
          threadId: decodeMentionableThreadId(String(thread.id)),
          mode: "code" as const,
          title: thread.title,
          placement: threadPlacement(thread.projectId, input.projectLabel),
          updatedAt: thread.updatedAt,
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
        }));
    },
    async readTranscript(windowId, mentionableThreadId) {
      const threadId = decodeCodeThreadId(String(mentionableThreadId));
      let turns: ReadonlyArray<Awaited<ReturnType<typeof input.conversation>>["turns"][number]> =
        [];
      try {
        // The Code conversation reader is forward-only, so the newest turns are
        // reachable only by walking to the end. Stopping early would hand a
        // stale window to another model while claiming it is recent, so an
        // unfinished walk fails closed instead.
        let cursor = 0;
        let pages = 0;
        const collected: Array<Awaited<ReturnType<typeof input.conversation>>["turns"][number]> =
          [];
        for (;;) {
          const page = await input.conversation(
            windowId,
            threadId,
            cursor,
            MAX_CODE_CONVERSATION_PAGE_SIZE,
          );
          collected.push(...page.turns);
          if (!page.hasMore) break;
          pages += 1;
          if (page.nextCursor <= cursor || pages >= MAX_CODE_MENTION_CONVERSATION_PAGES) {
            return undefined;
          }
          cursor = page.nextCursor;
        }
        turns = collected;
      } catch {
        return undefined;
      }
      const entries: ThreadMentionTranscriptEntry[] = [];
      // Only the tail can survive the mention window, and every entry costs an
      // evidence read, so older turns are dropped before any content is read.
      for (const turn of turns.slice(-MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES)) {
        const prompt = await readCodeEvidenceText(input, windowId, threadId, turn.operationId, [
          turn.prompt.contentId,
        ]);
        if (prompt !== undefined) {
          entries.push({ role: "user", text: prompt, occurredAt: turn.startedAt });
        }
        // Same honesty rule as Work: an incomplete, waiting, interrupted, or
        // failed turn has no answer, so its partial stream is neither read nor
        // quoted as one.
        if (turn.status !== "completed") continue;
        const response = await readCodeEvidenceText(
          input,
          windowId,
          threadId,
          turn.operationId,
          turn.assistant.map((reference) => reference.contentId),
        );
        if (response !== undefined) {
          entries.push({ role: "assistant", text: response, occurredAt: turn.updatedAt });
        }
      }
      return entries;
    },
  };
}

/**
 * Page budget for one mentioned Code thread. Each page is a bounded journal
 * scan, so the walk to the newest turn is capped rather than unbounded; a
 * thread that cannot be walked within it resolves as unreadable.
 */
const MAX_CODE_MENTION_CONVERSATION_PAGES = 100;

/**
 * Join one turn's evidence parts into a single entry, stopping as soon as the
 * per-entry cap is reached so a long streamed answer costs a bounded number of
 * reads. Returns `undefined` when nothing readable remains.
 */
async function readCodeEvidenceText(
  input: {
    readonly readEvidence: (
      windowId: WindowId,
      threadId: CodeThreadId,
      operationId: CodeOperationId,
      contentId: string,
    ) => Promise<{ readonly bytes: Uint8Array }>;
  },
  windowId: WindowId,
  threadId: CodeThreadId,
  operationId: CodeOperationId,
  contentIds: ReadonlyArray<string>,
): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let text = "";
  for (const contentId of contentIds) {
    if (text.length > MAX_THREAD_MENTION_ENTRY_CHARACTERS) break;
    try {
      const evidence = await input.readEvidence(windowId, threadId, operationId, contentId);
      text += decoder.decode(evidence.bytes);
    } catch {
      // Evidence the host cannot serve is simply absent from the window; a
      // mention never fabricates a placeholder for content it could not read.
    }
  }
  const normalized = text.trim();
  return normalized.length === 0 ? undefined : truncateEntry(normalized);
}

function threadPlacement(
  projectId: unknown,
  projectLabel: ((projectId: string) => string | undefined) | undefined,
): ThreadMentionPlacement {
  if (projectId === undefined || projectId === null) return { kind: "recents" };
  const label = projectLabel?.(String(projectId));
  return label === undefined || label.trim().length === 0
    ? { kind: "recents" }
    : { kind: "project", label };
}

/**
 * Per-entry cap applied before the window budget. One runaway turn must not be
 * able to consume the whole mention window on its own.
 */
const MAX_THREAD_MENTION_ENTRY_CHARACTERS = 4_000;

function truncateEntry(text: string): string {
  const normalized = text.trim();
  return normalized.length <= MAX_THREAD_MENTION_ENTRY_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_THREAD_MENTION_ENTRY_CHARACTERS - 1)}…`;
}

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
