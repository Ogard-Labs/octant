import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasSequenceBlock, CanvasStateBlock } from "@octant/contracts/canvas";

/**
 * The sequence an agent is shown when it asks how to draw a login flow.
 * Wire shape, not a branded block: describe returns this object as-is.
 */
export const loginSequenceExample = {
  blockId: "login-sequence",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "sequence" as const,
  participants: [
    { participantId: "person", label: "Person" },
    { participantId: "browser", label: "Browser" },
    { participantId: "auth", label: "Auth" },
  ],
  messages: [
    { messageId: "submit", from: "person", to: "browser", label: "Submit credentials" },
    { messageId: "sign-in", from: "browser", to: "auth", label: "Sign in" },
    { messageId: "session", from: "auth", to: "browser", label: "Session" },
  ],
  activations: [
    {
      activationId: "browser-active",
      participantId: "browser",
      startMessageId: "submit",
      endMessageId: "session",
    },
    {
      activationId: "auth-active",
      participantId: "auth",
      startMessageId: "sign-in",
      endMessageId: "session",
    },
  ],
  notes: [
    {
      noteId: "credential-note",
      text: "Credentials stay in the request",
      participantId: "browser",
      afterMessageId: "submit",
    },
  ],
};

/**
 * The state machine an agent is shown when it asks how to model an order.
 * Paid contains the payment steps; Cancelled and Closed are final.
 */
export const orderStateExample = {
  blockId: "order-states",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "state" as const,
  states: [
    { stateId: "start", label: "Start", role: "initial" as const },
    { stateId: "placed", label: "Placed" },
    { stateId: "paid", label: "Paid" },
    { stateId: "authorized", label: "Authorized", parentId: "paid" },
    { stateId: "captured", label: "Captured", parentId: "paid" },
    { stateId: "shipped", label: "Shipped" },
    { stateId: "cancelled", label: "Cancelled", role: "final" as const },
    { stateId: "closed", label: "Closed", role: "final" as const },
  ],
  transitions: [
    { transitionId: "place", source: "start", target: "placed", label: "place" },
    { transitionId: "pay", source: "placed", target: "paid", label: "pay" },
    { transitionId: "authorize", source: "paid", target: "authorized", label: "authorize" },
    { transitionId: "capture", source: "authorized", target: "captured", label: "capture" },
    { transitionId: "ship", source: "captured", target: "shipped", label: "ship" },
    { transitionId: "cancel", source: "placed", target: "cancelled", label: "cancel" },
    { transitionId: "deliver", source: "shipped", target: "closed", label: "deliver" },
  ],
};

function sequenceBlock(value: unknown): CanvasSequenceBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "sequence") {
    throw new Error("Sequence example did not decode as a sequence block.");
  }
  return block;
}

function stateBlock(value: unknown): CanvasStateBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "state") {
    throw new Error("State example did not decode as a state block.");
  }
  return block;
}

export const loginSequenceBlock = sequenceBlock(loginSequenceExample);
export const orderStateBlock = stateBlock(orderStateExample);
