import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import type {
  NativeHarnessFollowUpCreation,
  NativeHarnessFollowUpPreview,
  NativeHarnessFollowUpSuggestion,
  OctantMode,
  ThreadFollowUpSuggestions,
} from "@octant/contracts";
import {
  FollowUpSuggestionClientFailure,
  type FollowUpSuggestionClient,
} from "@octant/client-runtime/follow-up-suggestion-client";
import type { SideTaskClient } from "@octant/client-runtime/side-task-client";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { SideTaskCards } from "./SideTaskCards";
import { EnvironmentCard } from "../environment/EnvironmentGroup";
import "./follow-up-suggestions.css";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface FollowUpSuggestionChipsProps {
  readonly client: Pick<FollowUpSuggestionClient, "suggestions" | "preview" | "activate">;
  readonly threadId: string;
  readonly mode: OctantMode;
  /**
   * Called once a follow-up or side task has its thread, with the prompt that
   * should wait in that thread's composer; empty when it was already sent.
   */
  readonly onCreated: (input: {
    readonly mode: OctantMode;
    readonly created: NativeHarnessFollowUpCreation;
    readonly prompt: string;
  }) => void;
  readonly refreshIntervalMs?: number;
  /**
   * Wraps the cards when there are any, for a surface that frames them
   * (Environment's "Suggested tasks" card). Nothing is framed when the latest
   * reply offered nothing.
   */
  readonly frame?: (cards: ReactNode) => ReactNode;
}

export interface ComposerOffers extends FollowUpSuggestionChipsProps {
  readonly sideTaskClient?: Pick<SideTaskClient, "sideTasks" | "start" | "dismiss">;
}

/**
 * The thread a pane shows, for the composer inside it. Absent where a
 * composer has no thread yet, or where the thread lives on another host.
 */
export const FollowUpSuggestionContext = createContext<ComposerOffers | undefined>(undefined);

/** The side-task cards and follow-up chips for the thread around this composer, if any. */
export function ComposerFollowUpSuggestions() {
  const context = useContext(FollowUpSuggestionContext);
  if (context === undefined) return null;
  const { sideTaskClient, ...chips } = context;
  return (
    <>
      {sideTaskClient === undefined ? null : (
        <SideTaskCards
          client={sideTaskClient}
          onStarted={(started, unsentPrompt) =>
            context.onCreated({
              mode: started.mode,
              created: {
                kind: "new-thread",
                mode: started.mode,
                ...(started.projectId === undefined ? {} : { projectId: started.projectId }),
                title: started.title,
                threadId: started.threadId,
              },
              prompt: unsentPrompt ?? "",
            })
          }
          threadId={context.threadId}
        />
      )}
      <FollowUpSuggestionChips {...chips} />
    </>
  );
}

/** The next message the thread's latest reply suggested for this composer. */
export interface ComposerSuggestion {
  readonly prompt: string;
  /** Marks the suggestion used, so its card leaves the foot of the thread. */
  readonly markUsed: () => void;
}

const noFollowUps = () => () => undefined;

/**
 * The first open "next step here" suggestion of the thread around this
 * composer, which an empty composer shows as its placeholder and takes on Tab,
 * the way a terminal agent offers its next prompt. It reads the same feed the
 * cards do, so it adds no request. Using it records the activation the card's
 * Use prompt would; the composer puts the words in itself, so nothing waits
 * on the host.
 */
export function useComposerSuggestion(): ComposerSuggestion | undefined {
  const context = useContext(FollowUpSuggestionContext);
  const client = context?.client;
  const threadId = context?.threadId;
  const revision = useThreadActivityRevision("threadFollowUps");
  const effectiveMs = revision === undefined ? 4_000 : THREAD_ACTIVITY_RECOVERY_MS;
  const subscribe = useCallback(
    (listener: () => void) =>
      client === undefined || threadId === undefined
        ? noFollowUps()
        : subscribeFollowUps(client, threadId, effectiveMs, listener),
    [client, threadId, effectiveMs],
  );
  const suggestions = useSyncExternalStore(subscribe, () =>
    threadId === undefined ? null : (followUpFeeds.get(threadId)?.value ?? null),
  );
  useFollowUpRevision(client, threadId, revision);
  const dismissedTurnId = useDismissedTurn(threadId ?? "");
  if (client === undefined || threadId === undefined || suggestions === null) return undefined;
  const turnId = suggestions.followUps.turnId;
  if (String(turnId) === dismissedTurnId) return undefined;
  const next = suggestions.followUps.suggestions.find(
    (suggestion) =>
      suggestion.target === "same-thread" &&
      !suggestions.activatedFollowUpIds.some((id) => String(id) === String(suggestion.id)),
  );
  if (next === undefined) return undefined;
  return {
    prompt: next.prompt,
    markUsed: () => {
      void client
        .activate(threadId, { turnId, suggestionId: next.id, confirmed: true })
        .then(() => refreshThreadFollowUps(threadId))
        .catch(() => undefined);
    },
  };
}

/** The placeholder that shows a suggestion: its first line, kept to one row's worth. */
export function suggestionPlaceholder(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 119).trimEnd()}…` : firstLine;
}

interface FollowUpFeed {
  readonly client: Pick<FollowUpSuggestionClient, "suggestions">;
  value: ThreadFollowUpSuggestions | null;
  readonly listeners: Set<() => void>;
  revision: number | undefined;
  stop: () => void;
  load: () => Promise<void>;
}

/**
 * One reader per thread, shared by every surface that shows its suggestions
 * (the cards at the foot of the thread and Environment's copy). Two pollers
 * each storing their own answer doubled the requests, and the second one's
 * first answer re-rendered the thread pane mid-stream.
 */
const followUpFeeds = new Map<string, FollowUpFeed>();

function subscribeFollowUps(
  client: Pick<FollowUpSuggestionClient, "suggestions">,
  threadId: string,
  intervalMs: number,
  listener: () => void,
): () => void {
  let feed = followUpFeeds.get(threadId);
  if (feed === undefined || feed.client !== client) {
    feed?.stop();
    let inFlight = false;
    let readAgain = false;
    const created: FollowUpFeed = {
      client,
      value: feed?.value ?? null,
      listeners: feed?.listeners ?? new Set(),
      revision: undefined,
      stop: () => undefined,
      // A notice that lands during a read earns one trailing read, never more.
      // The guard comes first: a hidden window and a replaced feed read
      // nothing, so the trailing read also ends with the last unsubscribe.
      load: async () => {
        if (followUpFeeds.get(threadId) !== created || !documentIsVisible()) return;
        if (inFlight) {
          readAgain = true;
          return;
        }
        inFlight = true;
        try {
          const next = await client.suggestions(threadId);
          if (followUpFeeds.get(threadId) !== created) return;
          // An unchanged answer keeps the same value, so nothing re-renders.
          if (JSON.stringify(created.value) === JSON.stringify(next)) return;
          created.value = next;
          for (const notify of created.listeners) notify();
        } catch {
          // Suggestions are an offer, not state the person is waiting on; a
          // failed read keeps what was shown and the next read tries again.
        } finally {
          inFlight = false;
          if (readAgain) {
            readAgain = false;
            void created.load();
          }
        }
      },
    };
    const tick = () => void created.load();
    followUpFeeds.set(threadId, created);
    tick();
    const onOnline = () => tick();
    window.addEventListener("online", onOnline);
    const stopInterval = scheduleVisibleInterval(tick, intervalMs);
    created.stop = () => {
      window.removeEventListener("online", onOnline);
      stopInterval();
    };
    feed = created;
  }
  const active = feed;
  active.listeners.add(listener);
  return () => {
    active.listeners.delete(listener);
    if (active.listeners.size === 0) {
      active.stop();
      if (followUpFeeds.get(threadId) === active) followUpFeeds.delete(threadId);
    }
  };
}

function useFollowUpRevision(
  client: Pick<FollowUpSuggestionClient, "suggestions"> | undefined,
  threadId: string | undefined,
  revision: number | undefined,
): void {
  useEffect(() => {
    if (client === undefined || threadId === undefined || revision === undefined) return;
    const feed = followUpFeeds.get(threadId);
    if (feed === undefined || feed.client !== client || feed.revision === revision) return;
    const previouslyObserved = feed.revision;
    feed.revision = revision;
    if (previouslyObserved !== undefined) void feed.load();
  }, [client, revision, threadId]);
}

function useThreadFollowUps(
  client: Pick<FollowUpSuggestionClient, "suggestions">,
  threadId: string,
  intervalMs: number,
): ThreadFollowUpSuggestions | null {
  const revision = useThreadActivityRevision("threadFollowUps");
  const effectiveMs = revision === undefined ? intervalMs : THREAD_ACTIVITY_RECOVERY_MS;
  const subscribe = useCallback(
    (listener: () => void) => subscribeFollowUps(client, threadId, effectiveMs, listener),
    [client, effectiveMs, threadId],
  );
  const value = useSyncExternalStore(subscribe, () => followUpFeeds.get(threadId)?.value ?? null);
  useFollowUpRevision(client, threadId, revision);
  return value;
}

/** Reads a thread's suggestions again now, for every surface showing them. */
function refreshThreadFollowUps(threadId: string): Promise<void> {
  return followUpFeeds.get(threadId)?.load() ?? Promise.resolve();
}

/**
 * Which suggestion set the person dismissed on each thread, shared by every
 * surface that shows it: dismissing at the foot of the thread also hides the
 * Environment copy, and a remount does not bring it back. It lives for the
 * window; a later reply's new set shows again.
 */
const dismissedTurnByThread = new Map<string, string>();
const dismissalListeners = new Set<() => void>();

function dismissFollowUps(threadId: string, turnId: string): void {
  dismissedTurnByThread.set(threadId, turnId);
  for (const listener of dismissalListeners) listener();
}

function useDismissedTurn(threadId: string): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      dismissalListeners.add(listener);
      return () => dismissalListeners.delete(listener);
    },
    () => dismissedTurnByThread.get(threadId),
  );
}

function describeCreation(creation: NativeHarnessFollowUpCreation): string {
  if (creation.kind === "same-thread") return "goes in this composer for you to send";
  if (creation.kind === "new-worktree") return "starts a new Code thread on its own worktree";
  const mode = creation.mode === "chat" ? "Chat" : creation.mode === "work" ? "Work" : "Code";
  return `starts a new ${mode} thread${creation.projectId === undefined ? "" : " in this Project"}`;
}

/**
 * The next tasks the latest reply suggested, as cards at the foot of the
 * thread, just above the composer. Start… only shows what a card would
 * create; nothing is created until the person confirms, and the prompt then
 * waits in the new thread's composer.
 */
export function FollowUpSuggestionChips(props: FollowUpSuggestionChipsProps) {
  const { client, threadId } = props;
  // A preview and an error belong to the thread they were made for, so moving
  // the pane to another thread shows neither, without a reset on mount: a
  // mount-time reset cost a render each time the Environment copy re-attached.
  const [previewFor, setPreviewFor] = useState<{
    readonly threadId: string;
    readonly preview: NativeHarnessFollowUpPreview;
  }>();
  const [errorFor, setErrorFor] = useState<{
    readonly threadId: string;
    readonly message: string;
  }>();
  const [busy, setBusy] = useState(false);
  const preview = previewFor?.threadId === threadId ? previewFor.preview : undefined;
  const error = errorFor?.threadId === threadId ? errorFor.message : undefined;
  const setPreview = (next: NativeHarnessFollowUpPreview | undefined) =>
    setPreviewFor(next === undefined ? undefined : { threadId, preview: next });
  const setError = (message: string | undefined) =>
    setErrorFor(message === undefined ? undefined : { threadId, message });
  const suggestions = useThreadFollowUps(client, threadId, props.refreshIntervalMs ?? 4_000);
  const dismissedTurnId = useDismissedTurn(threadId);
  // The pane can move to another thread while a preview is on its way.
  const currentThread = useRef(threadId);
  currentThread.current = threadId;
  const load = useCallback(() => refreshThreadFollowUps(threadId), [threadId]);

  const open =
    suggestions?.followUps.suggestions.filter(
      (suggestion) =>
        !suggestions.activatedFollowUpIds.some((id) => String(id) === String(suggestion.id)),
    ) ?? [];
  if (
    suggestions === null ||
    open.length === 0 ||
    String(suggestions.followUps.turnId) === dismissedTurnId
  ) {
    return null;
  }
  const turnId = suggestions.followUps.turnId;

  const choose = async (suggestion: NativeHarnessFollowUpSuggestion) => {
    setError(undefined);
    const requestedFor = threadId;
    try {
      const result = await client.preview(requestedFor, String(suggestion.id));
      if (currentThread.current !== requestedFor) return;
      if ("wouldCreate" in result) setPreview(result);
      else
        setError(
          result.kind === "follow-up-refused"
            ? result.message
            : "This follow-up could not be previewed.",
        );
    } catch (failure) {
      if (currentThread.current !== requestedFor) return;
      setError(
        failure instanceof FollowUpSuggestionClientFailure
          ? failure.message
          : "This follow-up could not be previewed.",
      );
    }
  };

  const confirm = async () => {
    if (preview === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.activate(threadId, {
        turnId,
        suggestionId: preview.suggestion.id,
        confirmed: true,
      });
      if (result.kind === "follow-up-activated") {
        props.onCreated({
          mode: props.mode,
          created: result.created,
          prompt: preview.suggestion.prompt,
        });
        setPreview(undefined);
        await load();
      } else {
        setError(result.message);
      }
    } catch (failure) {
      setError(
        failure instanceof FollowUpSuggestionClientFailure
          ? failure.message
          : "This follow-up could not be started.",
      );
    } finally {
      setBusy(false);
    }
  };

  const cards = (
    <section aria-label="Suggested follow-ups" className="follow-up-cards">
      {open.map((suggestion) => {
        const previewing =
          preview !== undefined && String(preview.suggestion.id) === String(suggestion.id);
        return (
          <article
            aria-label={suggestion.title}
            className="follow-up-card"
            data-previewing={previewing ? "true" : undefined}
            key={String(suggestion.id)}
          >
            <div className="follow-up-card__head">
              <span className="follow-up-card__kind">{targetLabel(suggestion)}</span>
              <OctantIconButton
                label={`Dismiss ${suggestion.title}`}
                onClick={() => dismissFollowUps(threadId, String(turnId))}
                size="icon-xs"
                type="button"
              >
                <X aria-hidden="true" size={12} />
              </OctantIconButton>
            </div>
            <p className="follow-up-card__title">{suggestion.title}</p>
            <p className="follow-up-card__prompt">{suggestion.prompt}</p>
            {previewing && preview !== undefined ? (
              <div aria-label="Follow-up preview" className="follow-up-card__confirm" role="group">
                <p className="follow-up-card__summary">
                  This {describeCreation(preview.wouldCreate)}.
                </p>
                <div className="follow-up-card__actions">
                  <OctantButton
                    onClick={() => setPreview(undefined)}
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </OctantButton>
                  <OctantButton
                    disabled={busy}
                    onClick={() => void confirm()}
                    size="xs"
                    type="button"
                  >
                    {preview.wouldCreate.kind === "same-thread" ? "Use prompt" : "Start"}
                  </OctantButton>
                </div>
              </div>
            ) : (
              <div className="follow-up-card__actions">
                <OctantButton
                  aria-label={`Start ${suggestion.title}`}
                  onClick={() => void choose(suggestion)}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {suggestion.target === "same-thread" ? "Use here…" : "Start…"}
                </OctantButton>
              </div>
            )}
          </article>
        );
      })}
      {error === undefined ? null : (
        <OctantAlert className="follow-up-cards__error" tone="danger">
          {error}
        </OctantAlert>
      )}
    </section>
  );
  return props.frame === undefined ? cards : props.frame(cards);
}

/**
 * The same open suggestions in the Environment panel, so an offer the
 * conversation has scrolled past stays in reach. It reads the thread the
 * pane shows, through the composer's context.
 */
export function EnvironmentSuggestedTasks() {
  const context = useContext(FollowUpSuggestionContext);
  if (context === undefined) return null;
  const { sideTaskClient: _sideTasks, ...chips } = context;
  return (
    <FollowUpSuggestionChips
      {...chips}
      frame={(cards) => <EnvironmentCard caption="Suggested tasks">{cards}</EnvironmentCard>}
    />
  );
}

/** Where a suggestion would run, as the card's small heading. */
function targetLabel(suggestion: NativeHarnessFollowUpSuggestion): string {
  if (suggestion.target === "same-thread") return "Next step here";
  if (suggestion.target === "new-worktree") return "New task · own worktree";
  return "New task";
}
