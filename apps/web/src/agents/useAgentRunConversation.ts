import type {
  AgentRunConversationResponse,
  AgentRunConversationStreamFrame,
  AgentRunId,
} from "@octant/contracts";
import {
  AgentRunClientFailure,
  type AgentRunClient,
} from "@octant/client-runtime/agent-run-client";
import { useEffect, useState } from "react";

export interface AgentRunConversationController {
  readonly conversation: AgentRunConversationResponse | undefined;
  readonly loading: boolean;
  /** True after a live stream ends before the child reports a terminal state. */
  readonly reconnecting: boolean;
  readonly errorMessage: string | undefined;
}

/**
 * One stream for the currently selected child run. Selection changes abort the
 * old request before opening the new one, and every state write is tagged by
 * that request's run id so a late chunk can never appear in another pane.
 */
export function useAgentRunConversation(
  client: AgentRunClient,
  runId: AgentRunId | undefined,
): AgentRunConversationController {
  const [state, setState] = useState<{
    readonly runId: AgentRunId | undefined;
    readonly conversation: AgentRunConversationResponse | undefined;
    readonly loading: boolean;
    readonly reconnecting: boolean;
    readonly errorMessage: string | undefined;
  }>({
    runId: undefined,
    conversation: undefined,
    loading: false,
    reconnecting: false,
    errorMessage: undefined,
  });

  useEffect(() => {
    if (runId === undefined) {
      setState({
        runId: undefined,
        conversation: undefined,
        loading: false,
        reconnecting: false,
        errorMessage: undefined,
      });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setState({
      runId,
      conversation: undefined,
      loading: true,
      reconnecting: false,
      errorMessage: undefined,
    });
    if (client.subscribeConversation === undefined) {
      void client
        .conversation(runId)
        .then((conversation) => {
          if (cancelled) return;
          setState({
            runId,
            conversation,
            loading: false,
            reconnecting: false,
            errorMessage: undefined,
          });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setState((previous) => ({
            ...previous,
            loading: false,
            reconnecting: true,
            errorMessage:
              error instanceof AgentRunClientFailure
                ? error.message
                : "Live child transcript is unavailable. Reconnect and retry.",
          }));
        });
      return () => {
        cancelled = true;
      };
    }
    const subscribe = client.subscribeConversation;
    void (async () => {
      try {
        for await (const frame of subscribe(runId, undefined, controller.signal)) {
          if (cancelled) return;
          setState((previous) => {
            if (previous.runId !== runId) return previous;
            if (frame.kind === "snapshot" || previous.conversation === undefined) {
              const { kind: _kind, ...conversation } = frame;
              return {
                runId,
                conversation,
                loading: false,
                reconnecting: false,
                errorMessage: undefined,
              };
            }
            const previousSequence = previous.conversation.entries.at(-1)?.sequence ?? 0;
            const entries = [
              ...previous.conversation.entries,
              ...frame.entries.filter((entry) => entry.sequence > previousSequence),
            ];
            return {
              runId,
              conversation: { ...withoutKind(frame), entries },
              loading: false,
              reconnecting: false,
              errorMessage: undefined,
            };
          });
        }
        if (!cancelled) {
          setState((previous) =>
            previous.runId !== runId || previous.conversation?.status !== "live"
              ? previous
              : {
                  ...previous,
                  loading: false,
                  reconnecting: true,
                  errorMessage:
                    "Live child transcript disconnected; reconnect to continue viewing.",
                },
          );
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setState((previous) =>
          previous.runId !== runId
            ? previous
            : {
                ...previous,
                loading: false,
                reconnecting: true,
                errorMessage:
                  error instanceof AgentRunClientFailure
                    ? error.message
                    : "Live child transcript is unavailable. Reconnect and retry.",
              },
        );
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, runId]);

  return {
    conversation: state.runId === runId ? state.conversation : undefined,
    loading: state.runId === runId ? state.loading : runId !== undefined,
    reconnecting: state.runId === runId && state.reconnecting,
    errorMessage: state.runId === runId ? state.errorMessage : undefined,
  };
}

function withoutKind(frame: AgentRunConversationStreamFrame): AgentRunConversationResponse {
  const { kind: _kind, ...conversation } = frame;
  return conversation;
}
