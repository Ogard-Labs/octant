import type {
  LocalServerListener,
  LocalServerListenerId,
  LocalServerOpenTarget,
  LocalServerSnapshot,
} from "@octant/contracts";
import {
  CircleAlert,
  CircleHelp,
  Copy,
  ExternalLink,
  Globe2,
  Radio,
  ShieldAlert,
  Square,
} from "lucide-react";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import type { LocalServersController } from "./useLocalServersController";

export interface LocalServersGroupProps {
  readonly controller: Pick<
    LocalServersController,
    "status" | "snapshot" | "errorMessage" | "failure" | "busyListenerId" | "open" | "stop"
  >;
  /**
   * Creates a new host-owned Browser tab allowed to reach exactly one origin.
   * Absent means this host has nowhere to put the tab, so the Open control is
   * not rendered at all — a visible button that discards its target would be a
   * dead affordance.
   */
  readonly onOpenTarget?: (target: LocalServerOpenTarget) => void | Promise<void>;
  /** Writes the URL to the host clipboard. Absent hides the Copy control. */
  readonly onCopyUrl?: (url: string) => void | Promise<void>;
  /** Reason the section is unavailable, e.g. an unbound or rootless thread. */
  readonly unavailableReason?: string | undefined;
}

/**
 * Code Environment "Local servers" section.
 *
 * Every status is carried by an icon *and* words — never colour alone — because
 * the difference between a listener that answers and one that merely holds the
 * port is the whole point of the section. Rows the host did not classify are
 * simply absent: this surface refuses to be a host process inventory, so there
 * is no disabled row to read.
 */
export function LocalServersGroup(props: LocalServersGroupProps) {
  const [confirming, setConfirming] = useState<LocalServerListenerId>();

  if (props.unavailableReason !== undefined) {
    return (
      <p className="local-servers__state" role="status">
        {props.unavailableReason}
      </p>
    );
  }
  if (props.controller.status === "loading") {
    return (
      <p className="local-servers__state" role="status">
        Looking for local servers…
      </p>
    );
  }
  if (props.controller.status === "error") {
    return (
      <p className="local-servers__error" role="alert">
        {props.controller.errorMessage ?? "Local servers are unavailable."}
      </p>
    );
  }
  if (props.controller.snapshot === undefined) {
    // Idle is not a failure: the host has simply not been asked yet, which is
    // what a hidden or not-yet-authorized section looks like.
    return (
      <p className="local-servers__state" role="status">
        Octant is not observing local servers for this thread.
      </p>
    );
  }

  const snapshot: LocalServerSnapshot = props.controller.snapshot;
  const total = snapshot.currentCheckout.length + snapshot.other.length;

  return (
    <div aria-label="Local servers" className="local-servers">
      {props.controller.failure === undefined ? null : (
        <p className="local-servers__error" role="alert">
          <ShieldAlert aria-hidden="true" size={15} strokeWidth={1.8} />
          {props.controller.failure.message}
        </p>
      )}

      {total === 0 ? (
        <p className="local-servers__state" role="status">
          No local user or development servers are running.
        </p>
      ) : null}

      <LocalServerGroupSection
        {...props}
        confirming={confirming}
        heading="This Project"
        listeners={snapshot.currentCheckout}
        setConfirming={setConfirming}
      />
      <LocalServerGroupSection
        {...props}
        confirming={confirming}
        heading="Other leftovers"
        listeners={snapshot.other}
        setConfirming={setConfirming}
      />
    </div>
  );
}

function LocalServerGroupSection(
  props: LocalServersGroupProps & {
    readonly heading: string;
    readonly listeners: ReadonlyArray<LocalServerListener>;
    readonly confirming: LocalServerListenerId | undefined;
    readonly setConfirming: (next: LocalServerListenerId | undefined) => void;
  },
) {
  if (props.listeners.length === 0) return null;
  return (
    <section aria-label={props.heading} className="local-servers__group">
      <h3 className="local-servers__group-heading">{props.heading}</h3>
      {props.listeners.map((listener) => (
        <LocalServerRow
          key={listener.listenerId}
          confirming={props.confirming === listener.listenerId}
          listener={listener}
          busy={props.controller.busyListenerId === listener.listenerId}
          onCancelConfirm={() => props.setConfirming(undefined)}
          onCopyUrl={props.onCopyUrl}
          {...(props.onOpenTarget === undefined
            ? {}
            : {
                onOpen: async () => {
                  const target = await props.controller.open(listener.listenerId);
                  if (target !== undefined) await props.onOpenTarget?.(target);
                },
              })}
          onRequestStop={() => props.setConfirming(listener.listenerId)}
          onStop={async () => {
            await props.controller.stop(listener.listenerId, {
              acknowledgedProcessName: listener.processName,
              acknowledgedPort: listener.port,
              ...(listener.workingDirectory === undefined
                ? {}
                : { acknowledgedWorkingDirectory: listener.workingDirectory }),
            });
            props.setConfirming(undefined);
          }}
          onStopImmediately={async () => {
            await props.controller.stop(listener.listenerId);
          }}
        />
      ))}
    </section>
  );
}

/** How long a per-row success note such as "Copied" stays before it clears. */
const ROW_FEEDBACK_CLEAR_MS = 2_500;

function LocalServerRow(props: {
  readonly listener: LocalServerListener;
  readonly busy: boolean;
  readonly confirming: boolean;
  readonly onOpen?: (() => void | Promise<void>) | undefined;
  readonly onStop: () => void | Promise<void>;
  readonly onStopImmediately: () => void | Promise<void>;
  readonly onRequestStop: () => void;
  readonly onCancelConfirm: () => void;
  readonly onCopyUrl?: ((url: string) => void | Promise<void>) | undefined;
}) {
  const listener = props.listener;
  const health = healthPresentation(listener);
  const HealthIcon = health.icon;
  const stoppable = listener.stop.status === "available";
  const needsConfirmation = stoppable && listener.stop.confirmationRequired;
  // Copy and Open confirm or fail *in words* beside the row: a click with no
  // visible outcome is indistinguishable from a broken control.
  const [feedback, setFeedback] = useState<{
    readonly kind: "confirmation" | "failure";
    readonly text: string;
  }>();

  useEffect(() => {
    if (feedback?.kind !== "confirmation") return;
    const timer = setTimeout(() => setFeedback(undefined), ROW_FEEDBACK_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  const onOpen = props.onOpen;
  const onCopyUrl = props.onCopyUrl;

  return (
    <div className="local-servers__row" data-listener-id={listener.listenerId}>
      <div className="local-servers__identity">
        <span className="local-servers__name">
          {listener.processName}
          {listener.framework === undefined ? "" : ` · ${listener.framework}`}
        </span>
        <span className="local-servers__url" title={String(listener.url)}>
          {String(listener.url)}
        </span>
        <span className="local-servers__meta">
          <HealthIcon aria-hidden="true" size={14} strokeWidth={1.8} />
          {health.label}
        </span>
        <span className="local-servers__meta">
          <Radio aria-hidden="true" size={14} strokeWidth={1.8} />
          {listener.bindScope === "loopback" ? "This computer only" : "Reachable on your network"}
        </span>
        <span className="local-servers__meta">
          <Globe2 aria-hidden="true" size={14} strokeWidth={1.8} />
          {startSourceLabel(listener)}
        </span>
        {listener.workingDirectory === undefined ? null : (
          <span className="local-servers__meta" title={listener.workingDirectory}>
            {listener.workspaceLabel ?? listener.workingDirectory}
          </span>
        )}
      </div>

      <div className="local-servers__actions">
        {listener.openAvailable && onOpen !== undefined ? (
          <OctantButton
            aria-label={`Open ${String(listener.url)} in a new Browser tab`}
            disabled={props.busy}
            onClick={() =>
              void (async () => {
                setFeedback(undefined);
                try {
                  await onOpen();
                } catch {
                  setFeedback({
                    kind: "failure",
                    text: "Octant could not open a Browser tab for this server.",
                  });
                }
              })()
            }
            type="button"
            variant="ghost"
          >
            <ExternalLink aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Open</span>
          </OctantButton>
        ) : null}

        {onCopyUrl === undefined ? null : (
          <OctantButton
            aria-label={`Copy ${String(listener.url)}`}
            onClick={() =>
              void (async () => {
                setFeedback(undefined);
                try {
                  await onCopyUrl(String(listener.url));
                  setFeedback({ kind: "confirmation", text: "Copied" });
                } catch {
                  setFeedback({ kind: "failure", text: "Octant could not copy the URL." });
                }
              })()
            }
            type="button"
            variant="ghost"
          >
            <Copy aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Copy URL</span>
          </OctantButton>
        )}

        {feedback === undefined ? null : (
          <span
            className={`local-servers__action-feedback local-servers__action-feedback--${feedback.kind}`}
            role={feedback.kind === "failure" ? "alert" : "status"}
          >
            {feedback.text}
          </span>
        )}

        {listener.stop.status === "unavailable" ? (
          <span className="local-servers__stop-unavailable">
            <ShieldAlert aria-hidden="true" size={14} strokeWidth={1.8} />
            {listener.stop.reason}
          </span>
        ) : needsConfirmation ? (
          <OctantButton
            disabled={props.busy}
            onClick={props.onRequestStop}
            type="button"
            variant="ghost"
          >
            <Square aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Stop</span>
          </OctantButton>
        ) : (
          <OctantButton
            disabled={props.busy}
            onClick={() => void props.onStopImmediately()}
            type="button"
            variant="ghost"
          >
            <Square aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>Stop</span>
          </OctantButton>
        )}
      </div>

      {props.confirming && needsConfirmation ? (
        <div className="local-servers__confirm" role="alertdialog" aria-label="Confirm stop">
          <p>
            Stop {listener.processName} on port {listener.port}
            {listener.workingDirectory === undefined ? "" : ` in ${listener.workingDirectory}`}?
            Octant did not start this server.
          </p>
          <OctantButton onClick={() => void props.onStop()} type="button" variant="ghost">
            <span>Stop this server</span>
          </OctantButton>
          <OctantButton onClick={props.onCancelConfirm} type="button" variant="ghost">
            <span>Keep it running</span>
          </OctantButton>
        </div>
      ) : null}
    </div>
  );
}

/**
 * `unknown` is a statement about Octant, not about the server: the host ran out
 * of time asking, so the row says that instead of describing a listener nobody
 * established anything about.
 */
function healthPresentation(listener: LocalServerListener) {
  switch (listener.health) {
    case "listening":
      return { icon: Globe2, label: "Listening" };
    case "unresponsive":
      return { icon: CircleAlert, label: "Alive, but not responding" };
    case "unknown":
      return { icon: CircleHelp, label: "Octant could not check this server" };
  }
}

function startSourceLabel(listener: LocalServerListener): string {
  switch (listener.startSource) {
    case "octant":
      return "Started by Octant";
    case "vscode":
      return "Started by VS Code";
    case "claude":
      return "Started by Claude";
    case "codex":
      return "Started by Codex";
    case "other-editor":
      return "Started by another editor";
    case "unknown":
      return "Start source unknown";
  }
}
