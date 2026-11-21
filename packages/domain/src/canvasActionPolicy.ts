import {
  CANVAS_COMMAND_IDS,
  type CanvasActionCommand,
  type CanvasCommandId,
} from "@octant/contracts/canvas-actions";

/**
 * The independent enforcement set of allowlisted Octant commands a Canvas
 * action may reference. It intentionally mirrors the contract's
 * `CANVAS_COMMAND_IDS` so that the pure policy layer fails closed on any
 * identifier the contract has not registered, even if a decoder were bypassed.
 */
export const CANVAS_COMMAND_ALLOWLIST: ReadonlySet<CanvasCommandId> = new Set(CANVAS_COMMAND_IDS);

export function isAllowlistedCanvasCommand(command: string): command is CanvasCommandId {
  return (CANVAS_COMMAND_ALLOWLIST as ReadonlySet<string>).has(command);
}

export type CanvasActionEffect = "read" | "mutate";

export interface CanvasActionCapability {
  readonly command: CanvasCommandId;
  readonly effect: CanvasActionEffect;
  readonly requiresApproval: boolean;
}

// Capability report per registered command. Read-only commands only surface or
// attach already-authorized Canvas data. Mutating commands change workspace
// state and are reauthorized server-side; the ones that create a new
// user-visible thread are additionally approval-gated (design §7).
const CANVAS_ACTION_CAPABILITIES: Record<
  CanvasCommandId,
  { readonly effect: CanvasActionEffect; readonly requiresApproval: boolean }
> = {
  "canvas.open-source": { effect: "read", requiresApproval: false },
  "canvas.filter-data": { effect: "read", requiresApproval: false },
  "canvas.attach-selection": { effect: "read", requiresApproval: false },
  "canvas.open-thread": { effect: "read", requiresApproval: false },
  "canvas.open-pull-request": { effect: "read", requiresApproval: false },
  "canvas.request-refresh": { effect: "mutate", requiresApproval: false },
  "canvas.propose-thread": { effect: "mutate", requiresApproval: true },
};

export function classifyCanvasActionCommand(command: CanvasActionCommand): CanvasActionCapability {
  const capability = CANVAS_ACTION_CAPABILITIES[command.command];
  return { command: command.command, ...capability };
}
