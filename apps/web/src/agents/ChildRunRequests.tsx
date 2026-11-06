import type { NativeHarnessSessionReadView } from "@octant/contracts";
import type { NativeHarnessClient } from "@octant/client-runtime/native-harness-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { HarnessApprovalPanel } from "../harness/HarnessApprovalPanel";
import { ProviderQuestionCard } from "../transcript/ProviderQuestionCard";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";
import {
  isActiveAgentHierarchyStatus,
  type AgentHierarchyInputEntry,
} from "./buildAgentHierarchyModel";

export type ChildRunInteractionsClient = Pick<
  NativeHarnessClient,
  "session" | "decideApproval" | "answerQuestion"
> &
  Partial<Pick<NativeHarnessClient, "childRequests">>;

/** Reads the same requests answered in Agents; the parent never owns a second grant. */
export function ChildRunRequests(props: {
  readonly client: ChildRunInteractionsClient;
  readonly threadId: string;
  readonly entries: ReadonlyArray<AgentHierarchyInputEntry>;
  readonly disconnected: boolean;
  readonly onOpenSubagent?: (runId?: string) => void;
}) {
  const [read, setRead] = useState<{
    readonly threadId: string;
    readonly view: NativeHarnessSessionReadView | null;
  }>();
  const [stale, setStale] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);
  const reading = useRef<string | undefined>(undefined);
  const reload = useCallback(async () => {
    if (reading.current === props.threadId) return;
    reading.current = props.threadId;
    const mine = ++generation.current;
    try {
      const view =
        props.client.childRequests === undefined
          ? await props.client.session(props.threadId)
          : await props.client.childRequests(props.threadId);
      if (mine === generation.current) {
        setRead({ threadId: props.threadId, view });
        setStale(false);
      }
    } catch {
      if (mine === generation.current) setStale(true);
    } finally {
      if (reading.current === props.threadId) reading.current = undefined;
    }
  }, [props.client, props.threadId]);
  useEffect(() => {
    void reload();
    const stop = scheduleVisibleInterval(() => void reload(), 1_500);
    return () => {
      generation.current += 1;
      stop();
    };
  }, [reload]);
  const view = read?.threadId === props.threadId ? read.view : undefined;
  const requests = [...(view?.approvals ?? []), ...(view?.questions ?? [])].filter(
    (item) =>
      item.status === "pending" &&
      item.source !== undefined &&
      props.entries.some(
        (entry) =>
          entry.runId === String(item.source?.runId) &&
          isActiveAgentHierarchyStatus(entry.lifecycleStatus),
      ),
  );
  const request = requests.find((item) => String(item.id) === selected) ?? requests[0];
  useEffect(() => setNotice(undefined), [props.threadId, request?.id]);
  if (request === undefined || request.source === undefined) return null;
  const source = request.source;
  const entry = props.entries.find((item) => item.runId === String(source.runId));
  const recovering =
    view === undefined || view === null
      ? false
      : "session" in view
        ? view.session.status === "recovery-required"
        : false;
  const disabled = busy || stale || props.disconnected || recovering;
  const respond = async (
    send: () => Promise<{ readonly kind: string; readonly message?: string }>,
  ) => {
    if (disabled || submitting.current) return false;
    submitting.current = true;
    setBusy(true);
    try {
      const result = await send();
      const accepted = result.kind === "approval-decided" || result.kind === "question-answered";
      setNotice(
        accepted
          ? undefined
          : (result.message ?? "The request could not be answered. Refresh and try again."),
      );
      return accepted;
    } catch {
      setNotice("The response could not be confirmed. Check the request before trying again.");
      return false;
    } finally {
      await reload();
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <section aria-label="Child requests" className="composer-child-requests">
      <div className="composer-subagents__head">
        <strong>A subagent needs your input</strong>
        {props.onOpenSubagent === undefined ? null : (
          <OctantButton
            size="xs"
            variant="link"
            onClick={() => props.onOpenSubagent?.(String(source.runId))}
          >
            Open child
          </OctantButton>
        )}
      </div>
      <p>
        {entry?.task} · {source.providerName ?? String(source.providerInstanceId)} ·{" "}
        {source.modelId}
      </p>
      <p className="composer-subagents__meta">
        Connection: {source.providerInstanceId} · {source.targetFolder ?? "No folder reported"}
      </p>
      {requests.length < 2 ? null : (
        <div
          className="composer-child-requests__choices"
          role="group"
          aria-label="Pending child requests"
        >
          {requests.map((item, index) => (
            <OctantButton
              key={String(item.id)}
              size="xs"
              variant="ghost"
              disabled={busy}
              aria-pressed={item.id === request.id}
              onClick={() => setSelected(String(item.id))}
            >
              Request {index + 1}
            </OctantButton>
          ))}
        </div>
      )}
      {stale || props.disconnected ? (
        <OctantAlert tone="warning">Reconnect to answer this request.</OctantAlert>
      ) : null}
      {"toolName" in request ? (
        <HarnessApprovalPanel
          approval={request}
          busy={disabled}
          onDecide={(decision, commandHosts) => {
            if (decision === "approve-always") return;
            void respond(() =>
              props.client.decideApproval(props.threadId, {
                approvalId: String(request.id),
                decision,
                ...(commandHosts === undefined || decision !== "approve" ? {} : { commandHosts }),
              }),
            );
          }}
        />
      ) : (
        <fieldset disabled={disabled} className="composer-child-requests__question">
          <ProviderQuestionCard
            key={String(request.id)}
            prompt={request.prompt}
            questionnaire={request.questionnaire}
            options={request.options.map((label) => ({ label }))}
            onAnswer={(answer) =>
              respond(() =>
                props.client.answerQuestion(props.threadId, {
                  questionId: String(request.id),
                  answer,
                }),
              )
            }
          />
        </fieldset>
      )}
      {notice === undefined ? null : <OctantAlert tone="warning">{notice}</OctantAlert>}
    </section>
  );
}
