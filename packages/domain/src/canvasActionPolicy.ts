import {
  CANVAS_COMMAND_IDS,
  decodeCanvasActionBlock,
  type CanvasActionBlock,
  type CanvasActionCommand,
  type CanvasCommandId,
} from "@octant/contracts/canvas-actions";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";

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

export type CanvasActionDenialCode = "malformed" | "unknown-command" | "unsupported-schema";

export type CanvasActionAdmission =
  | {
      readonly kind: "admitted";
      readonly block: CanvasActionBlock;
      readonly capability: CanvasActionCapability;
    }
  | {
      readonly kind: "denied";
      readonly denialCode: CanvasActionDenialCode;
      readonly message: string;
    };

function deny(denialCode: CanvasActionDenialCode, message: string): CanvasActionAdmission {
  return { kind: "denied", denialCode, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fail-closed admission of a declarative Canvas action block.
 *
 * The block must decode against the versioned contract and reference a command
 * on the allowlist. Precise denial codes are returned before the schema decode
 * so an unknown command or an unsupported schema version never collapses into a
 * generic error, while excess fields, missing fields, executable-looking
 * payloads, and non-opaque references all fall through to `malformed`. No side
 * effect is ever produced: this is a pure policy boundary the server runs
 * before any action dispatch.
 */
export function admitCanvasActionBlock(input: unknown): CanvasActionAdmission {
  if (!isRecord(input)) {
    return deny("malformed", "Canvas action block must be an object.");
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== CANVAS_SCHEMA_VERSION) {
    return deny(
      "unsupported-schema",
      `Canvas action block schema version ${String(input.schemaVersion)} is not supported.`,
    );
  }
  const command = input.command;
  if (isRecord(command) && typeof command.command === "string") {
    if (!isAllowlistedCanvasCommand(command.command)) {
      return deny(
        "unknown-command",
        `Canvas command '${command.command}' is not on the Octant allowlist.`,
      );
    }
  }
  let block: CanvasActionBlock;
  try {
    block = decodeCanvasActionBlock(input);
  } catch {
    return deny("malformed", "Canvas action block failed contract validation.");
  }
  // Defense in depth: the decoded command literal is already constrained by the
  // contract union, but re-assert allowlist membership so the domain set stays
  // the authoritative enforcement boundary.
  if (!isAllowlistedCanvasCommand(block.command.command)) {
    return deny(
      "unknown-command",
      `Canvas command '${block.command.command}' is not on the Octant allowlist.`,
    );
  }
  return { kind: "admitted", block, capability: classifyCanvasActionCommand(block.command) };
}
