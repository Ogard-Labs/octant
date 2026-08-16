import type { ComputerUseSessionView } from "@octant/contracts/computer-use";
import { OctantButton } from "../ui/base/OctantButton";

export interface ComputerUseLifecyclePaneProps {
  readonly view: ComputerUseSessionView;
  readonly busy?: boolean;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  readonly onStop: () => void;
}

export function ComputerUseLifecyclePane(props: ComputerUseLifecyclePaneProps) {
  const active =
    props.view.state === "waiting-for-approval" ||
    props.view.state === "running" ||
    props.view.state === "stopping";
  return (
    <section aria-label="Computer use" className="computer-use-lifecycle">
      <header>
        <div>
          <p className="eyebrow">Host-controlled computer use</p>
          <h3>Computer use</h3>
        </div>
        <span aria-live="polite" role="status">
          {stateLabel(props.view.state)}
        </span>
      </header>

      {props.view.pendingApproval !== undefined ? (
        <div aria-label="Computer-use approval" role="group">
          <p>Octant is waiting for a one-time approval.</p>
          <strong>{props.view.pendingApproval.summary}</strong>
          <p>This approval is bound to this host, Project, thread, provider, action, and client.</p>
          <div>
            <OctantButton disabled={props.busy} onClick={props.onApprove} type="button">
              Approve once
            </OctantButton>
            <OctantButton
              disabled={props.busy}
              onClick={props.onDeny}
              type="button"
              variant="secondary"
            >
              Deny
            </OctantButton>
          </div>
        </div>
      ) : null}

      {active ? (
        <OctantButton
          disabled={props.busy || props.view.state === "stopping"}
          onClick={props.onStop}
          type="button"
          variant="secondary"
        >
          Stop computer use
        </OctantButton>
      ) : null}

      <ol aria-label="Computer-use lifecycle evidence">
        {props.view.events.map((event) => (
          <li key={event.sequence}>
            <span>{event.detail}</span>
            <time dateTime={event.occurredAt}>
              {new Date(event.occurredAt).toLocaleTimeString()}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function stateLabel(state: ComputerUseSessionView["state"]): string {
  switch (state) {
    case "requesting-approval":
    case "waiting-for-approval":
      return "Waiting for approval";
    case "active":
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped";
    case "expired":
      return "Expired";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
  }
}
