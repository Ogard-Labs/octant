import {
  decodeToolActionRequest,
  MAX_TOOL_ACTION_INTENT_BYTES,
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
      intent: requestIntent(intent),
      approval: { kind: "not-required" },
    });
  } catch {
    return refused("tool-authority-stale", STALE_AUTHORITY_MESSAGE);
  }
  const decision = authorize(options, request, args);
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
    // An approval can wait minutes for a person while the thread is switched
    // to Plan, narrowed from Full access, or loses its Project. The answer
    // covers the action under the authority it was asked under, so the action
    // runs only if the thread's authority now still allows it and asks no more
    // than the person already answered.
    if (options.resolveAuthority() === undefined) {
      return refused("tool-authority-stale", STALE_AUTHORITY_MESSAGE);
    }
    const recheck = authorize(options, request, args);
    if (
      recheck.kind === "deny" ||
      (recheck.kind === "prompt" &&
        (recheck.policy.approvalClass !== decision.policy.approvalClass ||
          (recheck.reason === "taint-requires-fresh-confirmation" &&
            decision.reason !== "taint-requires-fresh-confirmation")))
    ) {
      return refused(
        recheck.kind === "deny" ? recheck.reason : "approval-stale",
        `The thread's access changed while ${name} waited for approval, and its access now no longer allows it. Do not retry; say what you would have done.`,
      );
    }
  }
  return { status: "admitted", request } as const;
}

function authorize(options: AdmissionOptions, request: ToolActionRequest, args: unknown) {
  const turnExecutionPolicy = options.resolveTurnExecutionPolicy?.();
  return options.authority.authorize({
    threadId: options.threadId,
    request,
    arguments: args,
    ...(turnExecutionPolicy === undefined ? {} : { turnExecutionPolicy }),
  });
}

const encoder = new TextEncoder();

/**
 * Fits a summary to the request's intent, which refuses surrounding space and
 * more than its byte bound. Callers cut a long command to 2,048 characters for
 * the approval summary; a cut landing on a space, or 2,048 wide characters,
 * otherwise failed the call as tool-authority-stale before anyone was asked.
 */
function requestIntent(summary: string): string {
  const text = summary.trim();
  if (encoder.encode(text).byteLength <= MAX_TOOL_ACTION_INTENT_BYTES) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > MAX_TOOL_ACTION_INTENT_BYTES) break;
    end += character.length;
  }
  return text.slice(0, end).trimEnd();
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
