import type { BrowserAgentAvailability } from "@octant/contracts";

export type BrowserAgentOmission =
  | "no-tool-transport"
  | "excluded-by-thread-constraints"
  | "host-lends-no-browser";

export interface BrowserAgentAvailabilityNote {
  readonly message: string;
  /** Set when the host offers a way out; the toolbar's more menu carries it. */
  readonly omission?: BrowserAgentOmission;
  readonly remedy?: string;
}

/**
 * What the agent may do with this Browser, in a sentence. The toolbar folds it
 * into the status mark's name and tooltip instead of printing it as a row of
 * words, so a short sentence is all it needs to read.
 */
export function agentAvailabilityNote(
  availability: BrowserAgentAvailability | undefined,
): BrowserAgentAvailabilityNote {
  const state = availability ?? { status: "unknown" };
  if (state.status === "available") {
    return {
      message: state.readOnly
        ? "Agent can read this Browser in Plan."
        : "Agent can use this Browser.",
    };
  }
  if (state.status !== "omitted") return { message: "Browser availability is unknown." };
  const reason = state.reason;
  switch (reason) {
    case "no-tool-transport":
      return {
        message: "The agent cannot use this Browser: the provider has no supported tool transport.",
        omission: reason,
        remedy: "Choose provider",
      };
    case "excluded-by-thread-constraints":
      return {
        message: "The agent cannot use this Browser: the task's tool constraints exclude it.",
        omission: reason,
        remedy: "Review task access",
      };
    case "host-lends-no-browser":
      return {
        message: "The agent cannot use this Browser: the host does not lend it to this task.",
        omission: reason,
        remedy: "Check host settings",
      };
    default:
      return { message: "Browser availability is unknown." };
  }
}
