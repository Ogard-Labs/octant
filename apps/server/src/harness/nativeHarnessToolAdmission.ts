import {
  decodeToolActionRequest,
  nativeHarnessToolCapabilityId,
  type NativeHarnessToolName,
  type ToolActionRequest,
} from "@octant/contracts";
import type { CreateNativeHarnessToolsOptions } from "./nativeHarnessTools";

const STALE_AUTHORITY_MESSAGE =
  "This thread can no longer use tools: it was archived or deleted, its folder or Project changed, or its provider was turned off. Do not retry. Tell the person what you would have done, and that they can reopen the thread or start a new one.";

type AdmissionOptions = Pick<
  CreateNativeHarnessToolsOptions,
  "threadId" | "authority" | "resolveAuthority" | "resolveTurnExecutionPolicy" | "uuid"
> & {
  readonly ports: Pick<CreateNativeHarnessToolsOptions["ports"], "approvals">;
};

/** Reuses ordinary tool policy and approval without performing a tool effect. */
export async function admitNativeHarnessTool(
  options: AdmissionOptions,
  input: {
    readonly name: NativeHarnessToolName;
    readonly args: unknown;
    readonly intent: string;
    readonly approvedCheck?: string | undefined;
    readonly signal?: AbortSignal;
  },
) {
  const { name, args, intent, approvedCheck, signal } = input;
  const authority = options.resolveAuthority();
  if (authority === undefined) return refused("tool-authority-stale", STALE_AUTHORITY_MESSAGE);
  const capabilityId = nativeHarnessToolCapabilityId(name);
  let request: ToolActionRequest;
  try {
    request = decodeToolActionRequest({
      actionId: options.uuid(),
      correlationId: options.uuid(),
      capability: { id: capabilityId, version: 1 },
      authority,
      intent,
      approval: { kind: "not-required" },
    });
  } catch {
    return refused("tool-authority-stale", STALE_AUTHORITY_MESSAGE);
  }
  const turnExecutionPolicy = options.resolveTurnExecutionPolicy?.();
  const decision = options.authority.authorize({
    threadId: options.threadId,
    request,
    arguments: args,
    ...(turnExecutionPolicy === undefined ? {} : { turnExecutionPolicy }),
  });
  if (decision.kind === "deny") {
    return refused(
      decision.reason,
      decision.reason.startsWith("search-query-refused-under-taint")
        ? "This thread has taken in outside content, so a search may not carry data. Search with a short question in plain words, without URLs, addresses, keys, or encoded text."
        : `The ${name} tool was refused by policy.`,
    );
  }
  if (decision.kind === "prompt") {
    if (options.ports.approvals === undefined) {
      return refused(
        "approval-required",
        `The ${name} tool needs approval (${decision.policy.approvalClass}) under the thread's current access posture.`,
      );
    }
    const outcome = await options.ports.approvals({
      toolName: name,
      summary: request.intent,
      approvalClass: decision.policy.approvalClass,
      freshConfirmation: decision.reason === "taint-requires-fresh-confirmation",
      callId: String(request.actionId),
      arguments: args,
      ...(approvedCheck === undefined ? {} : { command: approvedCheck }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (outcome !== "approved") {
      return refused(
        outcome === "denied" || outcome === "shield-denied"
          ? "approval-denied"
          : `approval-${outcome}`,
        outcome === "denied"
          ? `The person did not allow ${name} here. Do not retry it; say what you would have done.`
          : outcome === "shield-denied"
            ? `Octant Shield did not allow ${name} here. Do not retry it; say what you would have done.`
            : outcome === "expired"
              ? `Nobody answered the approval for ${name} in time. Continue without it and say so.`
              : outcome === "too-many-waiting"
                ? `Too many approvals are already waiting for a person, so ${name} was not asked. Continue without it and say so.`
                : `The turn was cancelled while waiting for approval of ${name}.`,
      );
    }
  }
  return { status: "admitted", request } as const;
}
function refused(error: string, message?: string) {
  return {
    status: "refused",
    outcome: {
      result: { error, ...(message === undefined ? {} : { message }) },
      isError: true,
      refused: true,
    },
  } as const;
}
