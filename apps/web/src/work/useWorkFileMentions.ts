import { createFileMentionClient, type FileMentionClient } from "@octant/client-runtime";
import {
  decodeFileMentionRequestId,
  type FileMentionScope,
  type WorkThreadId,
} from "@octant/contracts";
import { reconcileFileMentionPaths } from "@octant/domain";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  applyPathMention,
  rankPathMentionCandidates,
  readPathMentionQuery,
  type PathMentionCandidate,
  type PathMentionQuery,
} from "../code/pathMentions";

export interface WorkFileMentionsOptions {
  readonly client?: FileMentionClient;
  readonly threadId?: WorkThreadId;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly textarea: () => HTMLTextAreaElement | null;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export interface WorkFileMentionsController {
  readonly open: boolean;
  readonly busy: boolean;
  readonly activeIndex: number;
  readonly candidates: ReadonlyArray<PathMentionCandidate>;
  readonly activeCandidate: PathMentionCandidate | undefined;
  readonly selectedPaths: ReadonlyArray<string>;
  readonly setActiveIndex: (index: number) => void;
  readonly sync: (draft: string, caretIndex: number | null) => void;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly choose: (candidate: PathMentionCandidate) => void;
  readonly clear: () => void;
}

/**
 * `@file` typeahead for the Work composer.
 *
 * Candidates come from the host's confined listing of this thread's bound
 * Project root. Choosing a file names it for the turn; the host still refuses
 * a path outside that root before reading it.
 */
export function useWorkFileMentions(options: WorkFileMentionsOptions): WorkFileMentionsController {
  const [mention, setMention] = useState<PathMentionQuery | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlyArray<string>>([]);
  const [candidates, setCandidates] = useState<ReadonlyArray<PathMentionCandidate>>([]);
  const [busy, setBusy] = useState(false);

  const client = useMemo(() => {
    if (options.client !== undefined) return options.client;
    if (options.serverUrl === undefined || options.windowCapability === undefined) return undefined;
    try {
      return createFileMentionClient({
        baseUrl: options.serverUrl,
        fetch: globalThis.fetch,
        windowCapability: options.windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [options.client, options.serverUrl, options.windowCapability]);

  const scope = useMemo((): FileMentionScope | undefined => {
    if (options.threadId === undefined) return undefined;
    return { mode: "work", threadId: options.threadId };
  }, [options.threadId]);

  useEffect(() => {
    setSelectedPaths((current) => {
      const kept = reconcileFileMentionPaths(options.draft, current);
      return kept.length === current.length ? current : kept;
    });
  }, [options.draft]);

  useEffect(() => {
    if (client === undefined || scope === undefined || mention === undefined) {
      setCandidates([]);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    const debounce = globalThis.setTimeout(() => {
      void (async () => {
        try {
          const hits = await client.complete(
            decodeFileMentionRequestId(globalThis.crypto.randomUUID()),
            scope,
            mention.query,
            controller.signal,
          );
          if (!controller.signal.aborted) {
            setCandidates(rankPathMentionCandidates(hits, mention.query));
          }
        } catch {
          if (!controller.signal.aborted) setCandidates([]);
        } finally {
          if (!controller.signal.aborted) setBusy(false);
        }
      })();
    }, 120);
    return () => {
      globalThis.clearTimeout(debounce);
      controller.abort();
    };
  }, [client, mention, scope]);

  const open = mention !== undefined && client !== undefined && scope !== undefined;
  const activeCandidate = open ? candidates[activeIndex] : undefined;

  function sync(draft: string, caretIndex: number | null) {
    const next = caretIndex === null ? undefined : readPathMentionQuery(draft, caretIndex);
    setMention(next);
    setActiveIndex(0);
  }

  function choose(candidate: PathMentionCandidate) {
    if (mention === undefined) return;
    const applied = applyPathMention(options.draft, mention, candidate);
    options.onDraftChange(applied.draft);
    if (candidate.kind === "file") {
      setSelectedPaths((current) =>
        current.includes(candidate.path) ? current : [...current, candidate.path],
      );
    }
    setMention(
      candidate.kind === "directory"
        ? { start: mention.start, query: `${candidate.path}/` }
        : undefined,
    );
    setActiveIndex(0);
    queueMicrotask(() => {
      const element = options.textarea();
      if (element === null) return;
      element.focus();
      element.setSelectionRange(applied.caret, applied.caret);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (open && candidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % candidates.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + candidates.length) % candidates.length);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && activeCandidate) {
        event.preventDefault();
        choose(activeCandidate);
        return true;
      }
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setMention(undefined);
      return true;
    }
    return false;
  }

  return {
    open,
    busy,
    activeIndex,
    candidates,
    activeCandidate,
    selectedPaths,
    setActiveIndex,
    sync,
    handleKeyDown,
    choose,
    clear: () => setSelectedPaths([]),
  };
}
