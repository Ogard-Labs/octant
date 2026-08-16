import type {
  ExtensionCapability,
  ProviderCapabilitySupport,
  ProviderExecutionPolicy,
  ToolActionAuthority,
  ToolActionRequest,
  ToolNetworkEgressPolicy,
} from "@octant/contracts";
import {
  authorizeToolAction,
  resolveNetworkEgressPolicy,
  resolveToolCall,
  type ToolCallDecisionReceipt,
  type ToolCallPolicyDecision,
  type ToolCallPolicyStep,
} from "@octant/domain";

export type ToolCallLiveFacts = {
  readonly providerAppManagedTools: ProviderCapabilitySupport;
  readonly host: {
    readonly computerUseEnabled: boolean;
    readonly prohibitedCapabilityClasses?: ReadonlyArray<ExtensionCapability | "validation">;
  };
  readonly remoteActor?: {
    readonly principalKind: "local-window" | "remote-device";
    readonly action: string;
    readonly requestedPrincipalKind?: "local-window" | "remote-device";
  };
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly approvalSatisfied: boolean;
  /**
   * Hook for the thread-lifetime external-content taint projection (untrusted
   * content provenance). Callers should plumb the live projection once it lands.
   */
  readonly externalContentIngested: boolean;
  readonly declaredCapabilities?: ReadonlyArray<ExtensionCapability>;
};

export type ToolCallAuthorityAuthorizeInput = {
  readonly threadId: string;
  readonly request: ToolActionRequest;
  readonly arguments: unknown;
};

export type ToolCallAuthorityDecision =
  | {
      readonly kind: "allow";
      readonly granted: ToolActionAuthority;
      readonly egressPolicy: ToolNetworkEgressPolicy;
      readonly receipt: ToolCallDecisionReceipt;
      readonly policy: Extract<ToolCallPolicyDecision, { kind: "allow" }>;
    }
  | {
      readonly kind: "prompt";
      readonly granted: ToolActionAuthority;
      readonly egressPolicy: ToolNetworkEgressPolicy;
      readonly reason: string;
      readonly receipt: ToolCallDecisionReceipt;
      readonly policy: Extract<ToolCallPolicyDecision, { kind: "prompt" }>;
    }
  | {
      readonly kind: "deny";
      readonly step?: ToolCallPolicyStep | "granted-authority" | "authority-match";
      readonly reason: string;
      readonly egressPolicy: ToolNetworkEgressPolicy;
      readonly receipt: ToolCallDecisionReceipt;
    };

export type ToolCallAuthorityServiceOptions = {
  readonly resolveGrantedAuthority: (
    threadId: string,
    mode: ToolActionAuthority["mode"],
  ) => ToolActionAuthority | undefined;
  readonly resolveLiveFacts: (input: {
    readonly threadId: string;
    readonly mode: ToolActionAuthority["mode"];
    readonly request: ToolActionRequest;
  }) => ToolCallLiveFacts;
  readonly onReceipt?: (receipt: ToolCallDecisionReceipt) => void;
  readonly clock?: () => string;
};

/**
 * Single server choke point for tool calls: compute granted `ToolActionAuthority`
 * from live thread state, run domain `resolveToolCall`, and emit a decision
 * receipt before any tool port may execute.
 */
export class ToolCallAuthorityService {
  readonly #resolveGrantedAuthority: ToolCallAuthorityServiceOptions["resolveGrantedAuthority"];
  readonly #resolveLiveFacts: ToolCallAuthorityServiceOptions["resolveLiveFacts"];
  readonly #onReceipt: ((receipt: ToolCallDecisionReceipt) => void) | undefined;
  readonly #clock: () => string;

  constructor(options: ToolCallAuthorityServiceOptions) {
    this.#resolveGrantedAuthority = options.resolveGrantedAuthority;
    this.#resolveLiveFacts = options.resolveLiveFacts;
    this.#onReceipt = options.onReceipt;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  authorize(input: ToolCallAuthorityAuthorizeInput): ToolCallAuthorityDecision {
    const mode = input.request.authority.mode;
    const live = this.#resolveLiveFacts({
      threadId: input.threadId,
      mode,
      request: input.request,
    });

    const granted = this.#resolveGrantedAuthority(input.threadId, mode);
    if (granted === undefined) {
      return this.#deny({
        step: "granted-authority",
        reason: "granted-authority-missing",
        capability: input.request.capability,
        mode,
        executionPolicy: live.executionPolicy,
      });
    }

    const matched = authorizeToolAction(input.request, granted);
    if (matched.kind !== "allowed") {
      return this.#deny({
        step: "authority-match",
        reason: "authority-mismatch",
        capability: input.request.capability,
        mode,
        executionPolicy: live.executionPolicy,
      });
    }

    const policy = resolveToolCall({
      capability: input.request.capability,
      extension: input.request.authority.extension,
      mode,
      arguments: input.arguments,
      providerAppManagedTools: live.providerAppManagedTools,
      host: live.host,
      ...(live.remoteActor === undefined ? {} : { remoteActor: live.remoteActor }),
      thread: {
        executionPolicy: live.executionPolicy,
        approvalSatisfied:
          live.approvalSatisfied &&
          input.request.approval.kind !== "pending" &&
          input.request.approval.kind !== "denied",
        externalContentIngested: live.externalContentIngested,
      },
      ...(live.declaredCapabilities === undefined
        ? {}
        : { declaredCapabilities: live.declaredCapabilities }),
      clock: this.#clock,
    });

    if (policy.kind === "deny") {
      this.#emit(policy.receipt);
      return {
        kind: "deny",
        step: policy.step,
        reason: policy.reason,
        egressPolicy: policy.egressPolicy,
        receipt: policy.receipt,
      };
    }

    if (policy.kind === "prompt") {
      this.#emit(policy.receipt);
      return {
        kind: "prompt",
        granted,
        egressPolicy: policy.egressPolicy,
        reason: policy.reason,
        receipt: policy.receipt,
        policy,
      };
    }

    this.#emit(policy.receipt);
    return {
      kind: "allow",
      granted,
      egressPolicy: policy.egressPolicy,
      receipt: policy.receipt,
      policy,
    };
  }

  #deny(input: {
    readonly step: "granted-authority" | "authority-match";
    readonly reason: string;
    readonly capability: ToolActionRequest["capability"];
    readonly mode: ToolActionAuthority["mode"];
    readonly executionPolicy: ProviderExecutionPolicy;
  }): ToolCallAuthorityDecision {
    const egressPolicy = resolveNetworkEgressPolicy({
      mode: input.mode,
      executionPolicy: input.executionPolicy,
    });
    const receipt: ToolCallDecisionReceipt = {
      decision: "deny",
      reason: input.reason,
      capabilityId: input.capability.id,
      capabilityVersion: input.capability.version,
      mode: input.mode,
      egressPolicy,
      actorKind: "system",
      recordedAt: this.#clock(),
    };
    this.#emit(receipt);
    return {
      kind: "deny",
      step: input.step,
      reason: input.reason,
      egressPolicy,
      receipt,
    };
  }

  #emit(receipt: ToolCallDecisionReceipt): void {
    this.#onReceipt?.(receipt);
  }
}
