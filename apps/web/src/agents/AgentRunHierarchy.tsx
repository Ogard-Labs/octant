import {
  decodeAgentRunId,
  decodeAgentRunRequestId,
  type AgentRunCreationPosture,
  type AgentRunParentThreadId,
} from "@octant/contracts/agent-run";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts/providers";
import {
  AgentRunClientFailure,
  type AgentRunClient,
} from "@octant/client-runtime/agent-run-client";
import {
  AgentRunSettingsClientFailure,
  type AgentRunSettingsClient,
} from "@octant/client-runtime/agent-run-settings-client";
import { useCallback, useEffect, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { AgentHierarchyPanel } from "./AgentHierarchyPanel";
import { AgentRunCreateForm, type AgentRunCreateFormValues } from "./AgentRunCreateForm";

export function AgentRunHierarchy(props: {
  readonly client: AgentRunClient;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly creationPosture?: AgentRunCreationPosture;
  /** Creation is opt-in until a surface has an authoritative Chat parent. */
  readonly allowCreation?: boolean;
  /** Fetches the server-authoritative posture. */
  readonly settingsClient?: AgentRunSettingsClient;
}) {
  const [entries, setEntries] = useState<
    Awaited<ReturnType<AgentRunClient["parentSummary"]>>["entries"]
  >([]);
  const [status, setStatus] = useState<"loading" | "ready" | "refreshing" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [posture, setPosture] = useState<AgentRunCreationPosture | undefined>(
    props.creationPosture,
  );
  const [creationError, setCreationError] = useState<string>();
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setStatus((current) => (current === "ready" ? "refreshing" : "loading"));
    try {
      const summary = await props.client.parentSummary(props.parentThreadId);
      setEntries(summary.entries);
      setErrorMessage(undefined);
      setStatus("ready");
    } catch (error) {
      setErrorMessage(
        error instanceof AgentRunClientFailure
          ? error.message
          : "AgentRun hierarchy is unavailable. Reconnect and retry.",
      );
      setStatus("error");
    }
  }, [props.client, props.parentThreadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!props.allowCreation || props.settingsClient === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await props.settingsClient!.current();
        if (!cancelled) setPosture(settings.creationPosture);
      } catch (error) {
        // The hierarchy stays usable (read/acknowledge/cancel) even if the
        // settings read fails; only child creation depends on this posture,
        // and AgentRunCreateForm's own server round trip is the last word.
        if (!cancelled && error instanceof AgentRunSettingsClientFailure) {
          setErrorMessage((current) => current ?? error.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.allowCreation, props.settingsClient]);

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

  const createChild = useCallback(
    async (values: AgentRunCreateFormValues) => {
      setCreationError(undefined);
      setCreating(true);
      try {
        const request = {
          requestId: decodeAgentRunRequestId(crypto.randomUUID()),
          parentThreadId: props.parentThreadId,
          role: values.role,
          task: values.task,
          mode: "chat" as const,
          providerInstanceId: decodeProviderInstanceId(values.providerInstanceId),
          modelId: decodeProviderModelId(values.modelId),
          ...(values.reasoning === undefined ? {} : { reasoning: values.reasoning }),
          ...(values.includeParentContext === true ? { includeParentContext: true } : {}),
          requestedAuthority: values.authority,
          workspace: { kind: "chat-virtual" as const, mode: "chat" as const },
        };
        const result = await props.client.requestRun(request);
        if (result.kind === "run-command-failed") {
          setCreationError(result.message ?? `Creation rejected: ${result.reason ?? "unknown"}.`);
          return;
        }
        await refresh();
      } catch (error) {
        setCreationError(
          error instanceof AgentRunClientFailure
            ? error.message
            : "The child request could not be built. Check the provider and model IDs.",
        );
      } finally {
        setCreating(false);
      }
    },
    [props.client, props.parentThreadId, refresh],
  );

  if (status === "loading") {
    return <p role="status">Loading authoritative AgentRun hierarchy…</p>;
  }
  if (status === "error" && entries.length === 0) {
    return (
      <ShellState
        action={{ label: "Retry Agents", onClick: () => void refresh() }}
        eyebrow="Agents"
        message={errorMessage ?? "The local AgentRun service is unavailable."}
        role="alert"
        state="warning"
        title="Agent hierarchy unavailable"
      />
    );
  }

  const effectivePosture = posture ?? "ask";

  return (
    <>
      {errorMessage === undefined ? null : (
        <p className="code-thread-workspace__error" role="alert">
          {errorMessage}
        </p>
      )}
      {props.allowCreation ? (
        <AgentRunCreateForm
          posture={effectivePosture}
          submitting={creating}
          {...(creationError === undefined ? {} : { errorMessage: creationError })}
          onSubmit={(values) => void createChild(values)}
        />
      ) : null}
      <AgentHierarchyPanel
        creationPosture={effectivePosture}
        entries={entries}
        onAcknowledge={(input) => void acknowledge(input)}
        onCancel={(input) => void cancel(input)}
        reconnecting={status === "refreshing"}
      />
    </>
  );
}
