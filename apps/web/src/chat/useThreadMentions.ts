import { createThreadMentionClient, type ThreadMentionClient } from "@octant/client-runtime";
import type {
  MentionableThreadId,
  SideChatSidecar,
  ThreadMentionCandidate,
  ThreadMentionRequestId,
} from "@octant/contracts";
import { reconcileThreadMentionChips } from "@octant/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatComposerThreadMentionChip, ChatComposerThreadMentions } from "./ChatComposer";

export interface ThreadMentionsOptions {
  /** Injected client; otherwise built from the loopback server URL. */
  readonly client?: ThreadMentionClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Caller-owned composer draft, used to drop chips the user deleted. */
  readonly draft: string;
  /** Called with the host's sidecar linkage after Side Chat opens. */
  readonly onSideChatOpened?: (sidecar: SideChatSidecar) => void;
  readonly requestId?: () => ThreadMentionRequestId;
  /** Enables the explicit Chat-to-Chat dialogue capability for this composer. */
  readonly dialogueEnabled?: boolean;
}

export interface ThreadMentionsController {
  /** Composer wiring, or `undefined` when no mention surface is reachable. */
  readonly composer: ChatComposerThreadMentions | undefined;
  readonly chips: ReadonlyArray<ChatComposerThreadMentionChip>;
  /**
   * Check every chip against the host and report the refused ones on the
   * chips themselves, so a mention the host will not read is shown as
   * unavailable rather than silently dropped.
   *
   * Returns the chips this send carries, as ids. The host re-derives the
   * sender's Open authority over each one when the turn runs, so the composer
   * forwards every chip the user still has rather than deciding on the host's
   * behalf — and never the transcript, which is the host's to read and to
   * frame, and which no composer puts in a message.
   */
  readonly resolveForSend: () => Promise<ReadonlyArray<MentionableThreadId>>;
  readonly clear: () => void;
  /** Restore chips that belonged to a send the host refused. */
  readonly restore: (chips: ReadonlyArray<ChatComposerThreadMentionChip>) => void;
}

/**
 * `#thread` mention state for a composer.
 *
 * Every fact here is the host's: which threads are mentionable, whether a
 * chip still resolves at send time, and whether a Side Chat sidecar exists.
 * The hook only tracks which chips the user picked and keeps them in step
 * with the draft — a chip whose text the user deleted stops contributing
 * context, and a chip the host later refuses is shown as unavailable rather
 * than silently dropped.
 */
export function useThreadMentions(options: ThreadMentionsOptions): ThreadMentionsController {
  const client = useMemo(() => {
    if (options.client !== undefined) return options.client;
    if (options.serverUrl === undefined || options.windowCapability === undefined) return undefined;
    try {
      return createThreadMentionClient({
        baseUrl: options.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: options.windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [options.client, options.serverUrl, options.windowCapability]);

  // The caller re-creates its options object every render, so the id minter and
  // the sidecar callback are held in refs: depending on them directly would
  // restart the search effect on every render and never settle.
  const requestIdRef = useRef(options.requestId ?? defaultRequestId);
  requestIdRef.current = options.requestId ?? defaultRequestId;
  const onSideChatOpenedRef = useRef(options.onSideChatOpened);
  onSideChatOpenedRef.current = options.onSideChatOpened;
  const newRequestId = useCallback(() => requestIdRef.current(), []);
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [candidates, setCandidates] = useState<ReadonlyArray<ThreadMentionCandidate>>([]);
  const [chips, setChips] = useState<ReadonlyArray<ChatComposerThreadMentionChip>>([]);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (client === undefined || query === undefined) {
      setCandidates([]);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    void (async () => {
      try {
        const hits = await client.search(newRequestId(), query, controller.signal);
        if (!controller.signal.aborted && mounted.current) setCandidates(hits);
      } catch {
        // A failed search shows no hits rather than stale ones; the `#text`
        // simply stays ordinary text.
        if (!controller.signal.aborted && mounted.current) setCandidates([]);
      } finally {
        if (!controller.signal.aborted && mounted.current) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [client, newRequestId, query]);

  // Chips are structured selections over the draft; when the user edits a chip
  // out of the text, it must stop contributing context.
  const draft = options.draft;
  useEffect(() => {
    setChips((current) => {
      const kept = reconcileThreadMentionChips(draft, current);
      return kept.length === current.length ? current : kept;
    });
  }, [draft]);

  const clear = useCallback(() => {
    setChips([]);
    setCandidates([]);
    setQuery(undefined);
    setStatusMessage(undefined);
  }, []);

  const restore = useCallback((next: ReadonlyArray<ChatComposerThreadMentionChip>) => {
    setChips([...next]);
    setCandidates([]);
    setQuery(undefined);
    setStatusMessage(undefined);
  }, []);

  const onSelectCandidate = useCallback((candidate: ThreadMentionCandidate) => {
    setStatusMessage(undefined);
    setChips((current) =>
      current.some((chip) => String(chip.threadId) === String(candidate.threadId))
        ? current
        : [
            ...current,
            {
              threadId: candidate.threadId,
              title: candidate.title,
              mode: candidate.mode,
              placementLabel: placementLabel(candidate.placement),
              ...(candidate.sideChatThreadId === undefined ? {} : { hasSideChat: true }),
            },
          ],
    );
    setQuery(undefined);
  }, []);

  const onRemoveChip = useCallback((threadId: MentionableThreadId) => {
    setChips((current) => current.filter((chip) => String(chip.threadId) !== String(threadId)));
  }, []);

  const onOpenSideChat = useCallback(
    (threadId: MentionableThreadId) => {
      if (client === undefined) return;
      void (async () => {
        try {
          const opened = await client.openSideChat(newRequestId(), threadId);
          if (!mounted.current) return;
          setChips((current) =>
            current.map((chip) =>
              String(chip.threadId) === String(threadId) ? { ...chip, hasSideChat: true } : chip,
            ),
          );
          onSideChatOpenedRef.current?.(opened.sidecar);
        } catch {
          if (mounted.current) setStatusMessage("Side Chat is unavailable for that thread.");
        }
      })();
    },
    [client, newRequestId],
  );

  const resolveForSend = useCallback(async (): Promise<ReadonlyArray<MentionableThreadId>> => {
    const threadIds = chips.map((chip) => chip.threadId);
    if (client === undefined || chips.length === 0) return threadIds;
    let resolved;
    try {
      resolved = await client.resolve(newRequestId(), threadIds);
    } catch {
      if (mounted.current) {
        setStatusMessage("Mentioned threads could not be read. Nothing was included.");
      }
      return threadIds;
    }
    if (mounted.current) {
      const refused = new Map(
        resolved.unavailable.map((entry) => [String(entry.threadId), entry.reason]),
      );
      setChips((current) =>
        current.map((chip) => {
          const reason = refused.get(String(chip.threadId));
          const { unavailableReason: _dropped, ...rest } = chip;
          return reason === undefined
            ? rest
            : { ...rest, unavailableReason: unavailableLabel(reason) };
        }),
      );
      setStatusMessage(
        resolved.unavailable.length === 0
          ? undefined
          : "Some mentioned threads are unavailable and were not included.",
      );
    }
    return threadIds;
  }, [chips, client, newRequestId]);

  const canOpenSideChat = options.onSideChatOpened !== undefined;
  const composer = useMemo((): ChatComposerThreadMentions | undefined => {
    if (client === undefined) return undefined;
    return {
      candidates,
      chips,
      ...(options.dialogueEnabled === true ? { dialogueEnabled: true } : {}),
      onQueryChange: setQuery,
      onSelectCandidate,
      onRemoveChip,
      // The chip's Side Chat control mints or reopens a sidecar. Offer it
      // only when a shell callback can actually open that tab; otherwise a
      // Side Chat or Code composer would create a hidden conversation the
      // user never sees.
      ...(canOpenSideChat ? { onOpenSideChat } : {}),
      busy,
      ...(statusMessage === undefined ? {} : { statusMessage }),
    };
  }, [
    busy,
    canOpenSideChat,
    candidates,
    options.dialogueEnabled,
    chips,
    client,
    onOpenSideChat,
    onRemoveChip,
    onSelectCandidate,
    statusMessage,
  ]);

  return { composer, chips, resolveForSend, clear, restore };
}

function placementLabel(placement: ThreadMentionCandidate["placement"]): string {
  if (placement.kind === "project") return placement.label;
  return placement.kind === "recents" ? "Recents" : "Unfiled";
}

/** Words for the host's refusal reason; never a bare code. */
function unavailableLabel(reason: "unauthorized" | "not-found" | "unsupported-mode"): string {
  if (reason === "not-found") return "the thread could not be read";
  if (reason === "unsupported-mode") return "this thread's mode cannot be mentioned";
  return "you cannot open this thread";
}

function defaultRequestId(): ThreadMentionRequestId {
  return crypto.randomUUID() as ThreadMentionRequestId;
}
