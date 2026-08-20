import type { ThreadMentionClient } from "@octant/client-runtime";
import type {
  ChatThreadId,
  MentionableThreadId,
  SideChatSidecar,
  ThreadMentionRequestId,
} from "@octant/contracts";
import { MessagesSquare } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface SideChatPanelProps {
  /** The workspace thread this Side Chat asks about, if one is open. */
  readonly sourceThreadId?: MentionableThreadId;
  readonly sourceTitle?: string;
  readonly client?: ThreadMentionClient;
  /**
   * Renders the sidecar's ordinary Chat surface. The panel owns only the
   * sidecar's identity and lifecycle; the caller owns the Chat controller, so
   * the sidecar is a real Chat thread rather than a second chat implementation.
   */
  readonly renderSidecar: (sidecarThreadId: ChatThreadId, sidecar: SideChatSidecar) => ReactNode;
  /** Called with the host's sidecar so the shell can persist the tab identity. */
  readonly onSidecarOpened?: (sidecar: SideChatSidecar) => void;
  readonly requestId?: () => ThreadMentionRequestId;
}

type SideChatState =
  | { readonly kind: "idle" }
  | { readonly kind: "opening" }
  | { readonly kind: "open"; readonly sidecar: SideChatSidecar }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Side Chat tab surface.
 *
 * Side Chat is the dedicated ask-about lane for one source thread: a persisted
 * Chat-mode sidecar the host gets-or-creates. It is not a second orchestration
 * surface — it cannot steer, approve, or append to the source thread, and it
 * holds no Work or Code filesystem, shell, Git, or worktree authority even
 * when the source thread is Work or Code. Sidecar identity is entirely the
 * host's: this panel asks for it and renders whatever it is told, including
 * "unavailable" when the Open check fails.
 */
export function SideChatPanel(props: SideChatPanelProps) {
  const [state, setState] = useState<SideChatState>({ kind: "idle" });
  const [retryToken, setRetryToken] = useState(0);
  const requestIdRef = useRef(props.requestId ?? defaultRequestId);
  requestIdRef.current = props.requestId ?? defaultRequestId;
  const onSidecarOpenedRef = useRef(props.onSidecarOpened);
  onSidecarOpenedRef.current = props.onSidecarOpened;
  const client = props.client;
  const sourceThreadId = props.sourceThreadId;

  useEffect(() => {
    if (client === undefined || sourceThreadId === undefined) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "opening" });
    void (async () => {
      try {
        const opened = await client.openSideChat(requestIdRef.current(), sourceThreadId);
        if (cancelled) return;
        setState({ kind: "open", sidecar: opened.sidecar });
        onSidecarOpenedRef.current?.(opened.sidecar);
      } catch {
        if (!cancelled) {
          setState({
            kind: "unavailable",
            reason: "Side Chat is unavailable for this thread.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, retryToken, sourceThreadId]);

  return (
    <section aria-label="Side Chat" className="side-chat">
      <header className="side-chat__header">
        <p className="side-chat__title">
          <MessagesSquare aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>
            {props.sourceTitle === undefined ? "Side Chat" : `Side Chat about ${props.sourceTitle}`}
          </span>
        </p>
        <p className="side-chat__notice">
          Ordinary Chat. It reads this thread and cannot steer, approve, or change it.
        </p>
      </header>
      {renderBody(state, props, () => setRetryToken((current) => current + 1))}
    </section>
  );
}

function renderBody(state: SideChatState, props: SideChatPanelProps, retry: () => void): ReactNode {
  if (props.client === undefined) {
    return (
      <p className="side-chat__empty" role="status">
        Side Chat is not available on this host.
      </p>
    );
  }
  if (state.kind === "idle") {
    return (
      <p className="side-chat__empty" role="status">
        Open a thread to ask about it here.
      </p>
    );
  }
  if (state.kind === "opening") {
    return (
      <p className="side-chat__empty" role="status">
        Opening Side Chat…
      </p>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <div className="side-chat__empty">
        <p role="alert">{state.reason}</p>
        <OctantButton onClick={retry} size="sm" type="button" variant="secondary">
          Try again
        </OctantButton>
      </div>
    );
  }
  return props.renderSidecar(state.sidecar.sidecarThreadId, state.sidecar);
}

function defaultRequestId(): ThreadMentionRequestId {
  return crypto.randomUUID() as ThreadMentionRequestId;
}
