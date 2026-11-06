import type { BrowserAgentAvailability } from "@octant/contracts";
import { Globe2 } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";

export function BrowserAgentStatus({
  availability,
  onRecover,
  agentDriving,
}: {
  readonly agentDriving?: boolean;
  readonly availability: BrowserAgentAvailability | undefined;
  readonly onRecover?: (
    reason: "no-tool-transport" | "excluded-by-thread-constraints" | "host-lends-no-browser",
  ) => void;
}) {
  if (agentDriving) return null;
  const state = availability ?? { status: "unknown" };
  const reason = state.status === "omitted" ? state.reason : undefined;
  const message =
    state.status === "available"
      ? state.readOnly
        ? "Agent can read this Browser in Plan."
        : "Agent can use this Browser."
      : reason === "no-tool-transport"
        ? "The agent cannot use this Browser: the provider has no supported tool transport."
        : reason === "excluded-by-thread-constraints"
          ? "The agent cannot use this Browser: the task's tool constraints exclude it."
          : reason === "host-lends-no-browser"
            ? "The agent cannot use this Browser: the host does not lend it to this task."
            : "Browser availability is unknown.";
  const remedy =
    reason === "no-tool-transport"
      ? "Choose provider"
      : reason === "excluded-by-thread-constraints"
        ? "Review task access"
        : "Check host settings";
  return (
    <span className="browser-workspace__agent-availability" role="status" title={message}>
      {reason !== undefined && onRecover !== undefined ? (
        <OctantButton
          aria-label={`${message} ${remedy}`}
          onClick={() => onRecover(reason)}
          size="xs"
          type="button"
          variant="ghost"
        >
          <Globe2 aria-hidden="true" size={12} />
          <span className="browser-workspace__availability-label">
            {message} {remedy}
          </span>
        </OctantButton>
      ) : (
        <span aria-label={message}>
          <Globe2 aria-hidden="true" size={12} />
          <span className="browser-workspace__availability-label">{message}</span>
        </span>
      )}
    </span>
  );
}
