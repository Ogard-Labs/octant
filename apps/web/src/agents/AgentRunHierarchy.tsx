import {
  decodeAgentRunId,
  type AgentRunCreationPosture,
  type AgentRunParentThreadId,
} from "@octant/contracts";
import {
  AgentRunClientFailure,
  type AgentRunClient,
  type AgentRunParentSummaryResponse,
} from "@octant/client-runtime/agent-run-client";
import {
  AgentRunSettingsClientFailure,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { AgentHierarchyPanel } from "./AgentHierarchyPanel";
import { ObservedChildDetail, observedChildSelectionId } from "./ObservedChildActivity";
import { AgentRunDetail } from "./AgentRunDetail";
import { buildAgentHierarchyModel, isActiveAgentHierarchyStatus } from "./buildAgentHierarchyModel";
import { useAgentRunControlCommands } from "./useAgentRunControlCommands";
import { useAgentRunConversation } from "./useAgentRunConversation";
import { OctantAlert } from "../ui/base/OctantAlert";

const ACTIVE_CHILD_REFRESH_MS = 2_000;

export function AgentRunHierarchy(props: {
  readonly client: AgentRunClient;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly creationPosture?: AgentRunCreationPosture;
  /** Fetches the server-authoritative posture, so a list turned off says so. */
  readonly settingsClient?: AgentRunSettingsClient;
  /**
   * A subagent someone asked to see from elsewhere — a row in the composer's
   * tray. The tool opens on its page, and reports the request handled once
   * the reader goes back to the list, so the tool opens on the list again.
   */
  readonly requestedRunId?: string;
  readonly onRequestedRunHandled?: () => void;
}) {
  const [read, setRead] = useState<AgentRunParentSummaryResponse>();
  const currentRead = read?.parentThreadId === props.parentThreadId ? read : undefined;
  const entries = currentRead?.entries ?? [];
  const observations = currentRead?.observations ?? [];
  const [status, setStatus] = useState<"loading" | "ready" | "refreshing" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [summaryReconnecting, setSummaryReconnecting] = useState(false);
  const [posture, setPosture] = useState<AgentRunCreationPosture | undefined>(
    props.creationPosture,
  );
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(props.requestedRunId);
  const onRequestedRunHandled = useRef(props.onRequestedRunHandled);
  onRequestedRunHandled.current = props.onRequestedRunHandled;
  // The request stands until the reader leaves the page it opened. Clearing it
  // on arrival lost it: the dock re-keys the tool body when the new tab gets
  // its id, and the remounted tool, finding no request, opened on the list.
  useEffect(() => {
    if (props.requestedRunId === undefined) return;
    setSelectedRunId(props.requestedRunId);
  }, [props.requestedRunId]);
  const leaveSelectedRun = () => {
    setSelectedRunId(undefined);
    if (props.requestedRunId !== undefined) onRequestedRunHandled.current?.();
  };
  // Only an identity resolved from the managed list may open a conversation.
  // Observation selection keys are presentation-only and never decoded as runs.
  const selectedEntry = entries.find((entry) => String(entry.runId) === selectedRunId);
  const selectedObservation = observations.find(
    (child) => observedChildSelectionId(child) === selectedRunId,
  );
  // The live conversation streams only while its page is open.
  const conversationState = useAgentRunConversation(props.client, selectedEntry?.runId);

  // Reads overlap: the beat below does not wait for the one before it, and a
  // refresh can land mid-beat. An older answer arriving last replaced a newer
  // list, hid a child accepted since, and could stop the beat. Only a read
  // issued after the one on screen may replace it.
  const issuedRead = useRef(0);
  const shownRead = useRef(0);
  const readSummary = useCallback(async () => {
    const read = ++issuedRead.current;
    const summary = await props.client.parentSummary(props.parentThreadId);
    if (read < shownRead.current) return;
    shownRead.current = read;
    setRead(summary);
    setSummaryReconnecting(false);
  }, [props.client, props.parentThreadId]);
  // A read still out when the panel closes or moves to another thread answers
  // for a list no longer shown.
  useEffect(
    () => () => {
      shownRead.current = ++issuedRead.current;
    },
    [props.client, props.parentThreadId],
  );

  const refresh = useCallback(async () => {
    setStatus((current) => (current === "ready" ? "refreshing" : "loading"));
    try {
      await readSummary();
      setErrorMessage(undefined);
      setStatus("ready");
    } catch (error) {
      setErrorMessage(
        error instanceof AgentRunClientFailure
          ? error.message
          : "Subagents are unavailable. Reconnect and retry.",
      );
      setStatus("error");
    }
  }, [readSummary]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The summary has no push channel. An idle panel still reads occasionally:
  // a provider can report its first child after the panel was opened.
  const anyActive = [...entries, ...observations].some((entry) =>
    isActiveAgentHierarchyStatus(entry.lifecycleStatus),
  );
  useEffect(() => {
    return scheduleVisibleInterval(
      () => {
        void readSummary().catch(() => setSummaryReconnecting(true));
      },
      anyActive ? ACTIVE_CHILD_REFRESH_MS : 30_000,
    );
  }, [anyActive, readSummary]);

  useEffect(() => {
    const settingsClient = props.settingsClient;
    if (settingsClient === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await settingsClient.current();
        if (!cancelled) setPosture(settings.creationPosture);
      } catch (error) {
        // The list stays usable (read/acknowledge/cancel) even if the
        // settings read fails; the posture only words the empty state.
        if (!cancelled && error instanceof AgentRunSettingsClientFailure) {
          setErrorMessage((current) => current ?? error.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.settingsClient]);

  const acknowledge = useCallback(
    async (input: { readonly runId: string; readonly version: number }) => {
      try {
        const result = await props.client.acknowledge({
          runId: decodeAgentRunId(input.runId),
          expectedVersion: input.version,
        });
        if (result.kind === "run-command-failed") {
          setErrorMessage(result.message);
          return;
        }
        await refresh();
      } catch (error) {
        setErrorMessage(
          error instanceof AgentRunClientFailure
            ? error.message
            : "AgentRun acknowledgement failed. Retry against authoritative state.",
        );
      }
    },
    [props.client, refresh],
  );

  const cancel = useCallback(
    async (input: { readonly runId: string }) => {
      try {
        const { results } = await props.client.cancel({
          runId: decodeAgentRunId(input.runId),
          scope: "subtree",
        });
        const failed = results.find((result) => result.kind === "run-command-failed");
        if (failed !== undefined) {
          setErrorMessage(failed.message ?? "AgentRun cancellation was rejected.");
        }
        await refresh();
      } catch (error) {
        setErrorMessage(
          error instanceof AgentRunClientFailure
            ? error.message
            : "AgentRun cancellation failed. Retry against authoritative state.",
        );
      }
    },
    [props.client, refresh],
  );

  const controls = useAgentRunControlCommands(props.client, refresh);

  const usageResume = useCallback(
    async (input: {
      readonly runId: string;
      readonly version: number;
      readonly action: "schedule" | "cancel";
    }) => {
      try {
        const result = await props.client.usageResume({
          runId: decodeAgentRunId(input.runId),
          expectedVersion: input.version,
          action: input.action,
        });
        if (result.kind === "run-command-failed") {
          setErrorMessage(result.message);
          return;
        }
        await refresh();
      } catch (error) {
        setErrorMessage(
          error instanceof AgentRunClientFailure
            ? error.message
            : "AgentRun usage-resume command failed. Retry against authoritative state.",
        );
      }
    },
    [props.client, refresh],
  );

  const model = useMemo(() => buildAgentHierarchyModel({ entries }), [entries]);

  if (status === "loading") {
    return <ShellState state="loading" title="Loading agents" />;
  }
  if (status === "error" && entries.length + observations.length === 0) {
    return (
      <ShellState
        action={{ label: "Retry Agents", onClick: () => void refresh() }}
        eyebrow="Agents"
        message={errorMessage ?? "The local AgentRun service is unavailable."}
        role="alert"
        state="warning"
        title="Subagents unavailable"
      />
    );
  }

  const effectivePosture = posture ?? "ask";
  const error = (
    <>
      {summaryReconnecting ? (
        <p className="agent-hierarchy__banner" role="status">
          Reconnecting. Showing the last child activity and results reported.
        </p>
      ) : null}
      {errorMessage === undefined ? null : (
        <OctantAlert className="code-thread-workspace__error" tone="danger">
          {errorMessage}
        </OctantAlert>
      )}
    </>
  );
  const selectedRow =
    selectedRunId === undefined
      ? undefined
      : [...model.working, ...model.finished].find((row) => row.runId === selectedRunId);

  if (selectedObservation !== undefined) {
    return (
      <>
        {error}
        <ObservedChildDetail child={selectedObservation} onBack={leaveSelectedRun} />
      </>
    );
  }

  if (selectedRow !== undefined) {
    return (
      <>
        {error}
        <AgentRunDetail
          key={selectedRow.runId}
          row={selectedRow}
          onBack={leaveSelectedRun}
          onAcknowledge={(input) => void acknowledge(input)}
          onCancel={(input) => void cancel(input)}
          onSteer={(input) => void controls.steer(input).then(setErrorMessage)}
          onRetry={(input) => void controls.retry(input).then(setErrorMessage)}
          onResume={(input) => void controls.resume(input).then(setErrorMessage)}
          onFollowUp={controls.resume}
          onUsageResume={(input) => void usageResume(input)}
          {...(conversationState.conversation === undefined
            ? {}
            : { conversation: conversationState.conversation })}
          conversationReconnecting={conversationState.reconnecting}
          conversationLoading={conversationState.loading}
          {...(conversationState.errorMessage === undefined
            ? {}
            : { conversationError: conversationState.errorMessage })}
        />
      </>
    );
  }

  return (
    <>
      {error}
      <AgentHierarchyPanel
        creationPosture={effectivePosture}
        entries={entries}
        observations={observations}
        observationsTruncated={currentRead?.observationsTruncated === true}
        onOpen={setSelectedRunId}
        reconnecting={status === "refreshing"}
      />
    </>
  );
}
