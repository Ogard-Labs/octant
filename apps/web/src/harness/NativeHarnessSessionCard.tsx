import { useCallback, useEffect, useState } from "react";
import type {
  NativeHarnessFollowUpCreation,
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
import { OctantInput } from "../ui/base/OctantInput";
import "./native-harness.css";

export interface NativeHarnessSessionCardProps {
  readonly client: Pick<
    NativeHarnessClient,
    | "session"
    | "command"
    | "previewFollowUp"
    | "activateFollowUp"
    | "answerQuestion"
    | "decideApproval"
  >;
  readonly threadId: string;
  /** Called with the standalone prompt once a follow-up is confirmed. */
  readonly onFollowUpActivated?: (input: {
    readonly preview: NativeHarnessFollowUpPreview;
    readonly created: NativeHarnessFollowUpCreation;
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
  const [draftAnswer, setDraftAnswer] = useState("");

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

  const pendingQuestion = view?.questions.find((question) => question.status === "pending");
  const pendingApproval = view?.approvals?.find((approval) => approval.status === "pending");
  useEffect(() => {
    void load();
    // A pending question deserves a quicker refresh: the lead is blocked on it.
    const interval = setInterval(
      () => void load(),
      props.refreshIntervalMs ??
        (pendingQuestion === undefined && pendingApproval === undefined ? 5_000 : 1_500),
    );
    return () => clearInterval(interval);
  }, [load, props.refreshIntervalMs, pendingQuestion === undefined, pendingApproval === undefined]);

  const decideApproval = useCallback(
    async (decision: "approve" | "approve-always" | "deny") => {
      if (pendingApproval === undefined || busy) return;
      setBusy(true);
      try {
        const result = await props.client.decideApproval(props.threadId, {
          approvalId: String(pendingApproval.id),
          decision,
        });
        if (result.kind === "approval-refused") setError(result.message);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [pendingApproval, busy, props.client, props.threadId, load],
  );

  const answerQuestion = useCallback(
    async (answer: string) => {
      if (pendingQuestion === undefined || busy) return;
      setBusy(true);
      try {
        const result = await props.client.answerQuestion(props.threadId, {
          questionId: String(pendingQuestion.id),
          answer,
        });
        if (result.kind === "question-refused") setError(result.message);
        setDraftAnswer("");
        await load();
      } finally {
        setBusy(false);
      }
    },
    [pendingQuestion, busy, props.client, props.threadId, load],
  );

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
        props.onFollowUpActivated?.({ preview, created: result.created });
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
      {pendingApproval === undefined ? null : (
        <section aria-label="Approval requested" className="native-harness-question">
          <p className="native-harness-question__prompt">
            <strong>{pendingApproval.toolName}</strong>{" "}
            {pendingApproval.summary.replace(/^[a-z-]+: /, "")}
          </p>
          <p className="native-harness-card__detail">
            Needs your say-so ({pendingApproval.approvalClass}).
          </p>
          <div className="native-harness-chips">
            <OctantButton
              disabled={busy}
              onClick={() => void decideApproval("approve")}
              size="sm"
              type="button"
              variant="default"
            >
              Allow
            </OctantButton>
            <OctantButton
              disabled={busy}
              onClick={() => void decideApproval("approve-always")}
              size="sm"
              type="button"
              variant="secondary"
            >
              Allow for this session
            </OctantButton>
            <OctantButton
              disabled={busy}
              onClick={() => void decideApproval("deny")}
              size="sm"
              type="button"
              variant="secondary"
            >
              Deny
            </OctantButton>
          </div>
        </section>
      )}
      {view.steering === undefined || view.steering.length === 0 ? null : (
        <ul aria-label="Notes for the running turn" className="native-harness-steering">
          {view.steering.map((note) => (
            <li key={note.id}>
              <span className="native-harness-steering__status">
                {note.status === "queued" ? "queued" : "delivered"}
              </span>{" "}
              {note.text}
            </li>
          ))}
        </ul>
      )}
      {pendingQuestion === undefined ? null : (
        <form
          aria-label="Question from the lead"
          className="native-harness-question"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = draftAnswer.trim();
            if (trimmed.length > 0) void answerQuestion(trimmed);
          }}
        >
          <p className="native-harness-question__prompt">{pendingQuestion.prompt}</p>
          {pendingQuestion.options.length === 0 ? null : (
            <div className="native-harness-chips">
              {pendingQuestion.options.map((option) => (
                <OctantButton
                  disabled={busy}
                  key={option}
                  onClick={() => void answerQuestion(option)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {option}
                </OctantButton>
              ))}
            </div>
          )}
          <div className="native-harness-panel__actions">
            <OctantInput
              aria-label="Answer"
              onChange={(event) => setDraftAnswer(event.target.value)}
              placeholder="Type an answer"
              value={draftAnswer}
            />
            <OctantButton
              disabled={busy || draftAnswer.trim().length === 0}
              type="submit"
              variant="default"
            >
              Send answer
            </OctantButton>
          </div>
        </form>
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
