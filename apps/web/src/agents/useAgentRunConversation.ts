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

const RECONNECT_BASE_DELAY_MS = 100;
const RECONNECT_MAX_DELAY_MS = 2_000;
const MAX_RECONNECT_ATTEMPTS = 6;

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
    let terminal = false;
    let connecting = false;
    let reconnectAttempt = 0;
    let cursor = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
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
    const updateFrame = (frame: AgentRunConversationStreamFrame): void => {
      if (cancelled) return;
      const lastSequence = frame.entries.at(-1)?.sequence;
      if (lastSequence !== undefined) cursor = Math.max(cursor, lastSequence);
      const parsedCursor = frame.nextCursor === undefined ? undefined : Number(frame.nextCursor);
      if (parsedCursor !== undefined && Number.isSafeInteger(parsedCursor)) {
        cursor = Math.max(cursor, parsedCursor);
      }
      reconnectAttempt = 0;
      terminal = frame.status !== "live";
      setState((previous) => {
        if (previous.runId !== runId) return previous;
        if (previous.conversation === undefined) {
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
    };
    const scheduleReconnect = (message: string): void => {
      if (cancelled || terminal || controller.signal.aborted || reconnectTimer !== undefined)
        return;
      if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        setState((previous) =>
          previous.runId !== runId
            ? previous
            : {
                ...previous,
                loading: false,
                reconnecting: true,
                errorMessage:
                  "Live child transcript could not reconnect. Retry by selecting it again.",
              },
        );
        return;
      }
      reconnectAttempt += 1;
      const delay = Math.min(
        RECONNECT_MAX_DELAY_MS,
        RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempt - 1),
      );
      setState((previous) =>
        previous.runId !== runId
          ? previous
          : {
              ...previous,
              loading: false,
              reconnecting: true,
              errorMessage: message,
            },
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void consume();
      }, delay);
    };
    const consume = async (): Promise<void> => {
      if (cancelled || terminal || controller.signal.aborted || connecting) return;
      connecting = true;
      try {
        for await (const frame of subscribe(
          runId,
          cursor === 0 ? undefined : cursor,
          controller.signal,
        )) {
          if (cancelled) return;
          updateFrame(frame);
          if (terminal) return;
        }
        if (!cancelled && !terminal) {
          scheduleReconnect("Live child transcript disconnected; reconnecting…");
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted || terminal) return;
        if (error instanceof AgentRunClientFailure && error.code !== "unavailable") {
          terminal = true;
          setState((previous) =>
            previous.runId !== runId
              ? previous
              : { ...previous, loading: false, reconnecting: false, errorMessage: error.message },
          );
          return;
        }
        scheduleReconnect(
          error instanceof AgentRunClientFailure
            ? error.message
            : "Live child transcript is unavailable. Reconnecting…",
        );
      } finally {
        connecting = false;
      }
    };
    void consume();
    return () => {
      cancelled = true;
      terminal = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
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
