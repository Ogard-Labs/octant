import { useCallback, useEffect, useState } from "react";
import type {
  NativeHarnessFollowUpPreview,
  NativeHarnessFollowUpSuggestion,
  NativeHarnessRouteDecision,
  NativeHarnessSessionView,
} from "@octant/contracts";
import {
  NativeHarnessClientFailure,
  type NativeHarnessClient,
} from "@octant/client-runtime/native-harness-client";
import { OctantButton } from "../ui/base/OctantButton";
import "./native-harness.css";

export interface NativeHarnessSessionCardProps {
  readonly client: Pick<
    NativeHarnessClient,
    "session" | "command" | "previewFollowUp" | "activateFollowUp"
  >;
  readonly threadId: string;
  /** Called with the standalone prompt once a follow-up is confirmed. */
  readonly onFollowUpActivated?: (input: {
    readonly preview: NativeHarnessFollowUpPreview;
  }) => void;
  readonly refreshIntervalMs?: number;
}

function describeRoute(decision: NativeHarnessRouteDecision): string {
  const model = "candidate" in decision ? String(decision.candidate.modelId) : undefined;
  switch (decision.kind) {
    case "primary":
      return `${decision.job} → ${decision.slotId} (${model})`;
    case "failure-fallback":
      return `${decision.job} → ${decision.slotId}: fell back to ${model} after ${decision.reason}`;
    case "reverted-to-primary":
      return `${decision.job} → ${decision.slotId}: back on ${model}`;
    case "overflow-promotion":
      return `${decision.job} → ${decision.slotId}: promoted to ${model} for ${decision.requiredTokens} tokens`;
    case "unconfigured-slot":
      return `${decision.job}: slot ${decision.requestedSlotId} is not configured, ran on ${decision.slotId} (${model})`;
    case "unroutable":
      return `${decision.job} → ${decision.slotId}: no model (${decision.reason})`;
  }
}

/**
 * The harness session for one thread: its status, the routing decisions that
 * were made, what the advisor did, and the follow-ups the lead suggested.
 * Nothing here spawns work by itself — a follow-up is previewed, confirmed,
 * and then handed to the surface's ordinary creation path.
 */
export function NativeHarnessSessionCard(props: NativeHarnessSessionCardProps) {
  const [view, setView] = useState<NativeHarnessSessionView | null>();
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<NativeHarnessFollowUpPreview>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await props.client.session(props.threadId));
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof NativeHarnessClientFailure
          ? failure.message
          : "The harness session is unavailable.",
      );
    }
  }, [props.client, props.threadId]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), props.refreshIntervalMs ?? 5_000);
    return () => clearInterval(interval);
  }, [load, props.refreshIntervalMs]);

  const pauseOrResume = useCallback(async () => {
    if (view === null || view === undefined || busy) return;
    setBusy(true);
    try {
      const paused = view.session.status !== "running" && view.session.status !== "idle";
      await props.client.command(props.threadId, {
        kind: paused ? "resume-native-harness-session" : "pause-native-harness-session",
        sessionId: view.session.id,
        expectedVersion: view.session.version,
      });
      await load();
    } finally {
      setBusy(false);
    }
  }, [props.client, props.threadId, view, busy, load]);

  const openPreview = useCallback(
    async (suggestion: NativeHarnessFollowUpSuggestion) => {
      const result = await props.client.previewFollowUp(props.threadId, String(suggestion.id));
      if ("wouldCreate" in result) setPreview(result);
      else setError(result.kind === "follow-up-refused" ? result.message : "Preview refused.");
    },
    [props.client, props.threadId],
  );

  const confirm = useCallback(async () => {
    if (
      preview === undefined ||
      view === null ||
      view === undefined ||
      view.followUps === undefined
    )
      return;
    setBusy(true);
    try {
      const result = await props.client.activateFollowUp(props.threadId, {
        turnId: view.followUps.turnId,
        suggestionId: preview.suggestion.id,
        confirmed: true,
      });
      if (result.kind === "follow-up-activated") {
        props.onFollowUpActivated?.({ preview });
        setPreview(undefined);
        await load();
      } else {
        setError(result.message);
      }
    } finally {
      setBusy(false);
    }
  }, [preview, props, view, load]);

  if (view === undefined) return <p role="status">Loading the harness session…</p>;
  if (view === null) return null;
  const paused = view.session.status !== "running" && view.session.status !== "idle";

  return (
    <section aria-label="Native harness" className="native-harness-card">
      <div className="native-harness-card__head">
        <h3>Native harness</h3>
        <span
          className={`native-harness-card__status native-harness-card__status--${view.session.status}`}
        >
          {view.session.status}
        </span>
        <OctantButton
          disabled={busy}
          onClick={() => void pauseOrResume()}
          size="sm"
          variant="secondary"
        >
          {paused ? "Resume" : "Pause"}
        </OctantButton>
      </div>
      {view.session.detail === undefined ? null : (
        <p className="native-harness-card__detail">{view.session.detail}</p>
      )}
      <dl className="native-harness-card__facts">
        <dt>Lead</dt>
        <dd>
          {String(view.session.lead.modelId)} on slot <code>{String(view.session.leadSlotId)}</code>
        </dd>
        <dt>Turns</dt>
        <dd>{view.session.turnsRun}</dd>
        <dt>Context cuts</dt>
        <dd>{view.session.cutovers}</dd>
      </dl>
      {view.routes.length === 0 ? null : (
        <>
          <h4>Routing</h4>
          <ul className="native-harness-card__list">
            {view.routes.slice(-5).map((decision, index) => (
              <li
                className={`native-harness-route native-harness-route--${decision.kind}`}
                key={index}
              >
                {describeRoute(decision)}
              </li>
            ))}
          </ul>
        </>
      )}
      {view.interventions.length === 0 ? null : (
        <>
          <h4>Advisor</h4>
          <ul className="native-harness-card__list">
            {view.interventions.slice(-5).map((intervention) => (
              <li key={String(intervention.id)}>
                <strong>{intervention.kind}</strong>{" "}
                {intervention.kind === "redirect"
                  ? intervention.instruction
                  : intervention.kind === "second-opinion"
                    ? intervention.answer
                    : intervention.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      {view.followUps === undefined || view.followUps.suggestions.length === 0 ? null : (
        <>
          <h4>Suggested next</h4>
          <div className="native-harness-chips">
            {view.followUps.suggestions.map((suggestion) => {
              const activated = view.activatedFollowUpIds.includes(suggestion.id);
              return (
                <OctantButton
                  disabled={activated || busy}
                  key={String(suggestion.id)}
                  onClick={() => void openPreview(suggestion)}
                  size="sm"
                  variant="secondary"
                >
                  {suggestion.title}
                  {activated ? " ✓" : ""}
                </OctantButton>
              );
            })}
          </div>
        </>
      )}
      {preview === undefined ? null : (
        <div className="native-harness-preview" role="dialog" aria-label="Follow-up preview">
          <p>
            <strong>{preview.suggestion.title}</strong> will{" "}
            {preview.wouldCreate.kind === "same-thread"
              ? "continue in this thread"
              : preview.wouldCreate.kind === "new-thread"
                ? `start a new ${preview.wouldCreate.mode} thread`
                : "start a new Code thread on its own worktree"}
            .
          </p>
          <pre className="native-harness-preview__prompt">{preview.suggestion.prompt}</pre>
          <div className="native-harness-panel__actions">
            <OctantButton disabled={busy} onClick={() => void confirm()} variant="default">
              Confirm
            </OctantButton>
            <OctantButton onClick={() => setPreview(undefined)} variant="ghost">
              Cancel
            </OctantButton>
          </div>
        </div>
      )}
      {error === undefined ? null : (
        <p className="native-harness-panel__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
