import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type {
  CanvasErBlock,
  CanvasMindmapBlock,
  CanvasSequenceBlock,
  CanvasStateBlock,
  CanvasSwimlaneBlock,
} from "@octant/contracts/canvas";

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

/**
 * The data model an agent is shown when it asks how to diagram a schema.
 * Person places Orders; an Order holds Order items and pays through a Payment.
 */
export const orderSchemaExample = {
  blockId: "order-schema",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "er" as const,
  entities: [
    {
      entityId: "person",
      label: "Person",
      attributes: [
        { attributeId: "person-id", name: "id", type: "uuid", key: true as const },
        { attributeId: "person-email", name: "email", type: "text" },
      ],
    },
    {
      entityId: "order",
      label: "Order",
      attributes: [
        { attributeId: "order-id", name: "id", type: "uuid", key: true as const },
        { attributeId: "order-total", name: "total", type: "money" },
        { attributeId: "order-person", name: "person_id", type: "uuid" },
      ],
    },
    {
      entityId: "payment",
      label: "Payment",
      attributes: [
        { attributeId: "payment-id", name: "id", type: "uuid", key: true as const },
        { attributeId: "payment-order", name: "order_id", type: "uuid" },
      ],
    },
  ],
  relationships: [
    {
      relationshipId: "person-places-order",
      source: "person",
      target: "order",
      sourceCardinality: "one" as const,
      targetCardinality: "many" as const,
      label: "places",
    },
    {
      relationshipId: "order-pays-payment",
      source: "order",
      target: "payment",
      sourceCardinality: "zero-or-one" as const,
      targetCardinality: "one" as const,
    },
  ],
};

/**
 * The flow an agent is shown when it asks how a request moves through teams.
 * Lanes are ordered people and teams; a decision step branches.
 */
export const supportFlowExample = {
  blockId: "support-flow",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "swimlane" as const,
  lanes: [
    { laneId: "customer", label: "Customer", kind: "actor" as const },
    { laneId: "support", label: "Support", kind: "team" as const },
    { laneId: "engineering", label: "Engineering", kind: "team" as const },
  ],
  steps: [
    { stepId: "report", laneId: "customer", label: "Report a problem" },
    {
      stepId: "triage",
      laneId: "support",
      label: "Is it a defect?",
      decision: true as const,
    },
    { stepId: "answer", laneId: "support", label: "Answer the question" },
    { stepId: "fix", laneId: "engineering", label: "Fix the defect" },
    { stepId: "close", laneId: "support", label: "Close the ticket" },
  ],
  connections: [
    { connectionId: "report-triage", source: "report", target: "triage" },
    { connectionId: "triage-answer", source: "triage", target: "answer", label: "no" },
    { connectionId: "triage-fix", source: "triage", target: "fix", label: "yes" },
    { connectionId: "fix-close", source: "fix", target: "close" },
    { connectionId: "answer-close", source: "answer", target: "close" },
  ],
};

/**
 * The mind map an agent is shown when it asks how to lay out a topic.
 * One root topic, branches that name their parent, and a note where useful.
 */
export const releaseMindmapExample = {
  blockId: "release-mindmap",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "mindmap" as const,
  nodes: [
    { nodeId: "release", label: "Release readiness" },
    {
      nodeId: "tests",
      label: "Test coverage",
      parentId: "release",
      note: "Unit and integration green on the head commit",
    },
    { nodeId: "docs", label: "Documentation", parentId: "release" },
    { nodeId: "architecture", label: "Architecture", parentId: "docs" },
    { nodeId: "guide", label: "User guide", parentId: "docs" },
    { nodeId: "packaging", label: "Packaging", parentId: "release" },
  ],
};

function erBlock(value: unknown): CanvasErBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "er") {
    throw new Error("Entity-relationship example did not decode as an er block.");
  }
  return block;
}

function swimlaneBlock(value: unknown): CanvasSwimlaneBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "swimlane") {
    throw new Error("Swimlane example did not decode as a swimlane block.");
  }
  return block;
}

function mindmapBlock(value: unknown): CanvasMindmapBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "mindmap") {
    throw new Error("Mind map example did not decode as a mindmap block.");
  }
  return block;
}

export const loginSequenceBlock = sequenceBlock(loginSequenceExample);
export const orderStateBlock = stateBlock(orderStateExample);
export const orderSchemaBlock = erBlock(orderSchemaExample);
export const supportFlowBlock = swimlaneBlock(supportFlowExample);
export const releaseMindmapBlock = mindmapBlock(releaseMindmapExample);
