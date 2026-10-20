import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
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
import { scheduleVisibleInterval } from "../polling/documentVisibility";
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
  const [suggestions, setSuggestions] = useState<ThreadFollowUpSuggestions | null>(null);
  const [preview, setPreview] = useState<NativeHarnessFollowUpPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dismissedTurnId, setDismissedTurnId] = useState<string>();
  const requestGeneration = useRef(0);
  const { client, threadId } = props;
  // The pane can move to another thread while a preview is on its way.
  const currentThread = useRef(threadId);
  currentThread.current = threadId;

  const load = useCallback(async () => {
    // A response for a thread the composer has left must not paint over the
    // one it shows now.
    const generation = ++requestGeneration.current;
    try {
      const next = await client.suggestions(threadId);
      if (requestGeneration.current === generation) setSuggestions(next);
    } catch {
      // Chips are an offer, not state the person is waiting on; a failed read
      // keeps what was shown and the next tick tries again.
    }
  }, [client, threadId]);

  useEffect(() => {
    setSuggestions(null);
    setPreview(undefined);
    setError(undefined);
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      inFlight = true;
      void load().finally(() => {
        inFlight = false;
      });
    };
    tick();
    const stop = scheduleVisibleInterval(tick, props.refreshIntervalMs ?? 4_000);
    return () => {
      requestGeneration.current += 1;
      stop();
    };
  }, [load, props.refreshIntervalMs]);

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
                onClick={() => setDismissedTurnId(String(turnId))}
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
