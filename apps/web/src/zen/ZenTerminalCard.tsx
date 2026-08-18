import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeCheckoutId,
  CodeOperationId,
  CodeOperationResult,
  CodeTerminalId,
  CodeThreadId,
  ProviderExecutionPolicy,
} from "@octant/contracts";
import { useEffect, useState } from "react";
import { CodeTerminalPane } from "../code/CodeTerminalPane";

type TerminalResult = Extract<CodeOperationResult, { readonly kind: "terminal-state" }>;

export interface ZenTerminalCardProps {
  readonly client: Pick<
    CodeClient,
    "executeOperation" | "inspectTerminal" | "operationContent" | "subscribeOperation"
  >;
  readonly createOperationId: () => CodeOperationId;
  /**
   * The thread the shell belongs to. Every keystroke this card sends is
   * authorized against this pair by the server, exactly as it is from the
   * workspace tab; the card holds the pair only so it can name it.
   */
  readonly scope: { readonly checkoutId: CodeCheckoutId; readonly threadId: CodeThreadId };
  readonly terminalId: CodeTerminalId;
  /** The thread's own posture. A pinned shell never reads as more permissive. */
  readonly executionPolicy: ProviderExecutionPolicy;
  /**
   * Whether this card holds one of the space's live slots. A card that has been
   * minimized, panned away from, or pushed past the budget stops following its
   * shell and picks it back up where it is when the slot comes back.
   */
  readonly live: boolean;
}

/**
 * A pinned window onto a terminal a Code thread already owns.
 *
 * The card binds by naming the shell and asking the server to hand back its
 * current state; it never starts one, and it never restarts one. Starting a
 * shell is something the Code thread does, and a card that could do it would be
 * reaching past what it was pinned to.
 */
export function ZenTerminalCard(props: ZenTerminalCardProps) {
  const [terminal, setTerminal] = useState<TerminalResult>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (!props.live) return;
    let active = true;
    void (async () => {
      try {
        const inspection = await props.client.inspectTerminal({
          terminalId: props.terminalId,
          ...props.scope,
        });
        if (!active) return;
        if (String(inspection.terminalId) !== String(props.terminalId)) {
          setFailure("This terminal answered for a different process.");
          return;
        }
        const result = await props.client.executeOperation({
          kind: "attach-terminal",
          operationId: props.createOperationId(),
          terminalId: props.terminalId,
          ...props.scope,
        });
        if (!active) return;
        if (result.kind !== "terminal-state") {
          setFailure("This terminal is no longer running.");
          return;
        }
        setTerminal(result);
        setFailure(undefined);
      } catch {
        if (active) setFailure("This terminal is unavailable.");
      }
    })();
    return () => void (active = false);
  }, [props.client, props.createOperationId, props.live, props.scope, props.terminalId]);

  if (failure !== undefined) {
    return (
      <p className="zen-terminal-card__notice" role="status">
        {failure}
      </p>
    );
  }
  if (!props.live) {
    return (
      <p className="zen-terminal-card__notice" role="status">
        Paused while this card is out of view. It picks the shell back up when you return to it.
      </p>
    );
  }
  if (terminal === undefined) {
    return (
      <p className="zen-terminal-card__notice" role="status">
        Opening this terminal…
      </p>
    );
  }
  return (
    <CodeTerminalPane
      client={props.client}
      createOperationId={props.createOperationId}
      executionPolicy={props.executionPolicy}
      result={terminal}
      scope={props.scope}
    />
  );
}
