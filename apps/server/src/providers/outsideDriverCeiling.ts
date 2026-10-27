import type { ProviderCapabilities, ProviderCapabilitySupport } from "@octant/contracts";
import type { OutsideDriverCapabilityClaims } from "@octant/contracts/outside-driver-protocol";
import { unsupportedChatCapabilities } from "@octant/provider-sdk/chat-conformance";

/**
 * The most an outside harness endpoint can offer: the bundled harness
 * endpoints' own declaration. The host owns the conversation, resumes it by
 * replaying the history it holds, and interrupts by aborting; there are no
 * provider approvals, questions, file changes, or runtime compaction; and
 * `appManagedTools` stays `unsupported` for the whole instance, so Octant's
 * tools reach only the models the host verified (`verifiedToolModelIds`).
 * Every gate that reads "provider-wide support, or this model verified"
 * (`modelCanTakeDelegatedWork` among them) therefore sees only the host's
 * record, never a driver's claim.
 */
const outsideHarnessEndpointCeiling: ProviderCapabilities = {
  streaming: "unavailable",
  resume: "supported",
  interruption: "supported",
  approvals: "unsupported",
  userQuestions: "unsupported",
  reasoning: "unavailable",
  usage: "unavailable",
  toolActivity: "unsupported",
  fileChanges: "unsupported",
  diffs: "unsupported",
  taskProgress: "unsupported",
  nativeChildAgents: "unsupported",
  harnessAutoReview: "unsupported",
  sessionCompaction: { chat: "unsupported", work: "unsupported", code: "supported" },
  ...unsupportedChatCapabilities,
};

/** What the host has seen a response do; each lifts one `unavailable` cell of the ceiling. */
export interface OutsideDriverShownCapabilities {
  readonly streaming: boolean;
  readonly reasoning: boolean;
  readonly usage: boolean;
}

const rank: Readonly<Record<ProviderCapabilitySupport, number>> = {
  unsupported: 0,
  unavailable: 1,
  supported: 2,
};

function lower(
  ceiling: ProviderCapabilitySupport,
  claim: ProviderCapabilitySupport | undefined,
): ProviderCapabilitySupport {
  return claim !== undefined && rank[claim] < rank[ceiling] ? claim : ceiling;
}

/**
 * An outside instance's capabilities: the ceiling, lifted only where a
 * response has shown streaming, reasoning, or usage, and lowered wherever the
 * driver claims less. A claim above the ceiling is ignored rather than
 * refused, and a capability the ceiling omits stays omitted, which reads as
 * unsupported.
 */
export function clampOutsideDriverCapabilities(
  claims: OutsideDriverCapabilityClaims | undefined,
  shown: OutsideDriverShownCapabilities,
): ProviderCapabilities {
  const lifted: ProviderCapabilities = {
    ...outsideHarnessEndpointCeiling,
    streaming: shown.streaming ? "supported" : outsideHarnessEndpointCeiling.streaming,
    reasoning: shown.reasoning ? "supported" : outsideHarnessEndpointCeiling.reasoning,
    usage: shown.usage ? "supported" : outsideHarnessEndpointCeiling.usage,
  };
  return {
    ...lifted,
    streaming: lower(lifted.streaming, claims?.streaming),
    resume: lower(lifted.resume, claims?.resume),
    interruption: lower(lifted.interruption, claims?.interruption),
    approvals: lower(lifted.approvals, claims?.approvals),
    userQuestions: lower(lifted.userQuestions, claims?.userQuestions),
    reasoning: lower(lifted.reasoning, claims?.reasoning),
    usage: lower(lifted.usage, claims?.usage),
    toolActivity: lower(lifted.toolActivity, claims?.toolActivity),
    fileChanges: lower(lifted.fileChanges, claims?.fileChanges),
    diffs: lower(lifted.diffs, claims?.diffs),
    taskProgress: lower(lifted.taskProgress, claims?.taskProgress),
    nativeChildAgents: lower(lifted.nativeChildAgents, claims?.nativeChildAgents),
    nativeAttachments: lower(lifted.nativeAttachments, claims?.nativeAttachments),
    nativeWebResearch: lower(lifted.nativeWebResearch, claims?.nativeWebResearch),
    appManagedTools: lower(lifted.appManagedTools, claims?.appManagedTools),
    citations: lower(lifted.citations, claims?.citations),
    harnessAutoReview: lower(lifted.harnessAutoReview, claims?.harnessAutoReview),
  };
}
