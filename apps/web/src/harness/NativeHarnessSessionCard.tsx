import { useCallback, useEffect, useRef, useState } from "react";
import type { NativeHarnessRouteDecision, NativeHarnessSessionView } from "@octant/contracts";
import {
  NativeHarnessClientFailure,
  type NativeHarnessClient,
} from "@octant/client-runtime/native-harness-client";
import {
  nativeHarnessSessionHeld,
  nativeHarnessStatusLabel,
  sessionStatsInputOf,
  threadStats,
} from "@octant/domain";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import "./native-harness.css";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface NativeHarnessSessionCardProps {
  readonly client: Pick<
    NativeHarnessClient,
    "session" | "command" | "answerQuestion" | "decideApproval"
  >;
  readonly threadId: string;
  readonly refreshIntervalMs?: number;
}

function describeRoute(decision: NativeHarnessRouteDecision): string {
  const model = "candidate" in decision ? String(decision.candidate.modelId) : undefined;
  switch (decision.kind) {
    case "inherited-parent":
      return `${decision.job}: inherited parent model (${model})`;
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
 * were made, and what the advisor did. The follow-ups a reply suggests are
 * the thread's on every provider and show over its composer instead.
 */
export function NativeHarnessSessionCard(props: NativeHarnessSessionCardProps) {
  const [view, setView] = useState<NativeHarnessSessionView | null>();
  const requestGeneration = useRef(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const [draftAnswer, setDraftAnswer] = useState("");

  const load = useCallback(async () => {
    // A response for a thread the card has left must not paint over the one it
    // is showing now, and neither must a response after unmount.
    const generation = ++requestGeneration.current;
    try {
      const next = await props.client.session(props.threadId);
      if (requestGeneration.current !== generation) return;
      setView(next);
      setError(undefined);
    } catch (failure) {
      if (requestGeneration.current !== generation) return;
      setError(
        failure instanceof NativeHarnessClientFailure
          ? failure.message
          : "The harness session is unavailable.",
      );
    }
  }, [props.client, props.threadId]);

  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );

  const pendingQuestion = view?.questions.find((question) => question.status === "pending");
  const pendingApproval = view?.approvals?.find((approval) => approval.status === "pending");
  useEffect(() => {
    let inFlight = false;
    const tick = () => {
      // A host read can outlast the interval; overlapping it only queues work
      // the newer response will discard.
      if (inFlight) return;
      inFlight = true;
      void load().finally(() => {
        inFlight = false;
      });
    };
    tick();
    // A pending question deserves a quicker refresh: the lead is blocked on it.
    return scheduleVisibleInterval(
      tick,
      props.refreshIntervalMs ??
        (pendingQuestion === undefined && pendingApproval === undefined ? 5_000 : 1_500),
    );
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
      const held = nativeHarnessSessionHeld(view.session.status);
      const result = await props.client.command(props.threadId, {
        kind: held ? "resume-native-harness-session" : "pause-native-harness-session",
        sessionId: view.session.id,
        expectedVersion: view.session.version,
      });
      // A resume the host refused says what stands in the way; dropping it
      // would leave a button that silently does nothing.
      setRefusal(result.kind === "native-harness-session-refused" ? result.message : undefined);
      await load();
    } finally {
      setBusy(false);
    }
  }, [props.client, props.threadId, view, busy, load]);

  if (view === undefined) {
    // The Agents tab mounts this card above the run hierarchy, which shows
    // the tab's one loading line; a second spinner here stacked two.
    return error === undefined ? null : <OctantAlert tone="warning">{error}</OctantAlert>;
  }
  if (view === null) return null;
  const stats = threadStats(sessionStatsInputOf(view));
  const paused = nativeHarnessSessionHeld(view.session.status);

  return (
    <section aria-label="Agent coordination" className="native-harness-card">
      <div className="native-harness-card__head">
        <h3>Agent coordination</h3>
        <span
          className={`native-harness-card__status native-harness-card__status--${view.session.status}`}
        >
          {nativeHarnessStatusLabel(view.session.status)}
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
      {refusal === undefined ? null : (
        <OctantAlert className="native-harness-card__detail" tone="warning">
          {refusal}
        </OctantAlert>
      )}
      {pendingApproval === undefined ? null : (
        <section aria-label="Approval requested" className="native-harness-question">
          {pendingApproval.source === undefined ? null : (
            <p className="native-harness-card__detail" title={String(pendingApproval.source.runId)}>
              Child {String(pendingApproval.source.runId).slice(0, 8)} ·{" "}
              {pendingApproval.source.providerName ?? "Provider"} · {pendingApproval.source.modelId}
            </p>
          )}
          <p className="native-harness-question__prompt">
            <strong>
              {pendingApproval.toolName === "provider-action"
                ? "Provider action"
                : pendingApproval.toolName}
            </strong>{" "}
            {pendingApproval.summary.replace(/^[a-z-]+: /, "")}
          </p>
          <p className="native-harness-card__detail">
            {pendingApproval.source === undefined
              ? `Needs your say-so (${pendingApproval.approvalClass}).`
              : "Allow this request for this child."}
          </p>
          {pendingApproval.detail === undefined ? null : (
            <pre className="native-harness-question__detail">{pendingApproval.detail}</pre>
          )}
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
            {pendingApproval.source === undefined ? (
              <OctantButton
                disabled={busy}
                onClick={() => void decideApproval("approve-always")}
                size="sm"
                type="button"
                variant="secondary"
              >
                Allow for this session
              </OctantButton>
            ) : null}
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
          aria-label={
            pendingQuestion.source === undefined
              ? "Question from the lead"
              : "Question from a subagent"
          }
          className="native-harness-question"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = draftAnswer.trim();
            if (trimmed.length > 0) void answerQuestion(trimmed);
          }}
        >
          {pendingQuestion.source === undefined ? null : (
            <p className="native-harness-card__detail" title={String(pendingQuestion.source.runId)}>
              Child {String(pendingQuestion.source.runId).slice(0, 8)} ·{" "}
              {pendingQuestion.source.providerName ?? "Provider"} · {pendingQuestion.source.modelId}
            </p>
          )}
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
        {stats.length === 0 ? null : (
          <>
            <dt>Usage</dt>
            <dd className="native-harness-card__stats" data-testid="native-harness-stats">
              {stats.map((stat) =>
                stat.hint === undefined ? (
                  <span key={stat.key}>{stat.text}</span>
                ) : (
                  <OctantTooltip key={stat.key} label={stat.hint} side="top">
                    <span data-hinted="true">{stat.text}</span>
                  </OctantTooltip>
                ),
              )}
            </dd>
          </>
        )}
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
      {error === undefined ? null : (
        <OctantAlert className="native-harness-panel__error" tone="danger">
          {error}
        </OctantAlert>
      )}
    </section>
  );
}
