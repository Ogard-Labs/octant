import {
  decodeAgentRunId,
  type AgentRunCreationPosture,
  type AgentRunParentThreadId,
} from "@octant/contracts";
import {
  AgentRunClientFailure,
  type AgentRunClient,
} from "@octant/client-runtime/agent-run-client";
import {
  AgentRunSettingsClientFailure,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { AgentHierarchyPanel } from "./AgentHierarchyPanel";
import { AgentRunDetail } from "./AgentRunDetail";
import { buildAgentHierarchyModel, isActiveAgentHierarchyStatus } from "./buildAgentHierarchyModel";
import { useAgentRunConversation } from "./useAgentRunConversation";

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
  const [entries, setEntries] = useState<
    Awaited<ReturnType<AgentRunClient["parentSummary"]>>["entries"]
  >([]);
  const [status, setStatus] = useState<"loading" | "ready" | "refreshing" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
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
  // The live conversation streams only while its page is open.
  const conversationState = useAgentRunConversation(
    props.client,
    selectedRunId === undefined ? undefined : decodeAgentRunId(selectedRunId),
  );

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
    setEntries(summary.entries);
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

  // The summary has no push channel, so a child that finished while the panel
  // sat open kept reading "starting" until the person clicked something. While
  // any child is still active, read the summary again on a short beat; once
  // every child has settled the panel stops asking.
  const anyActive = entries.some((entry) => isActiveAgentHierarchyStatus(entry.lifecycleStatus));
  useEffect(() => {
    if (!anyActive) return;
    const timer = window.setInterval(() => {
      // A missed beat is retried by the next one; the explicit refresh path
      // owns the visible error.
      void readSummary().catch(() => undefined);
    }, ACTIVE_CHILD_REFRESH_MS);
    return () => window.clearInterval(timer);
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

  const command = useCallback(
    async (
      action: "steer" | "retry" | "resume",
      input: { readonly runId: string; readonly version: number; readonly message?: string },
    ) => {
      try {
        const runId = decodeAgentRunId(input.runId);
        const result =
          action === "steer"
            ? await props.client.steer({
                runId,
                expectedVersion: input.version,
                message: input.message ?? "",
              })
            : action === "retry"
              ? await props.client.retry({ runId, expectedVersion: input.version })
              : await props.client.resume({ runId, expectedVersion: input.version });
        if (result.kind === "run-command-failed") {
          setErrorMessage(result.message);
          return;
        }
        await refresh();
      } catch (error) {
        setErrorMessage(
          error instanceof AgentRunClientFailure
            ? error.message
            : "AgentRun command failed. Retry against authoritative state.",
        );
      }
    },
    [props.client, refresh],
  );

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
  if (status === "error" && entries.length === 0) {
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
  const error =
    errorMessage === undefined ? null : (
      <p className="code-thread-workspace__error" role="alert">
        {errorMessage}
      </p>
    );
  const selectedRow =
    selectedRunId === undefined
      ? undefined
      : [...model.working, ...model.finished].find((row) => row.runId === selectedRunId);

  if (selectedRow !== undefined) {
    return (
      <>
        {error}
        <AgentRunDetail
          row={selectedRow}
          onBack={leaveSelectedRun}
          onAcknowledge={(input) => void acknowledge(input)}
          onCancel={(input) => void cancel(input)}
          onSteer={(input) => void command("steer", input)}
          onRetry={(input) => void command("retry", input)}
          onResume={(input) => void command("resume", input)}
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
        onOpen={setSelectedRunId}
        reconnecting={status === "refreshing"}
      />
    </>
  );
}
