import {
  decideExtensionToolGrant,
  type ExtensionToolGrantDecision,
} from "@octant/domain/extension-tool-grant-policy";
import type { ApprovalOutsideContent, WindowId } from "@octant/contracts";
import type { ExtensionToolGrantSubject } from "../persistence/extensionToolGrantProjection";
import type { ExtensionToolCall } from "./agentPluginMcpSessionManager";
import type { ExtensionToolApprovalService } from "./extensionToolApprovalService";
import type { ExtensionToolGrantStore } from "./extensionToolGrantStore";

/**
 * Decides whether an MCP tool call may run: a remembered approval for exactly
 * this tool in this Project covers it, and otherwise a person is asked in the
 * turn's window. A grant is recorded only from inside that prompt's answer,
 * so nothing a model, a tool, or a route sends can create one.
 */
export function createExtensionToolCallAuthorizer(options: {
  readonly grants: Pick<ExtensionToolGrantStore, "read" | "record">;
  readonly approvals: Pick<ExtensionToolApprovalService, "request">;
  /**
   * Whether the scope a turn runs under is the host acting on its own (a
   * routine, a goal loop, a usage-limit resume, a child-run delivery). Such a
   * turn's prompt is approved once and never remembered.
   */
  readonly isHostScope: (windowId: WindowId) => boolean;
  /** Whether the thread has taken in outside content, from the journal's taint. */
  readonly threadTainted: (threadId: string) => boolean;
  /** The sources that marked the thread, which its prompt names. */
  readonly outsideContent?: (threadId: string) => ApprovalOutsideContent | undefined;
}): (call: ExtensionToolCall) => Promise<boolean> {
  const judge = (
    call: ExtensionToolCall,
  ): {
    readonly subject: ExtensionToolGrantSubject | undefined;
    readonly decision: ExtensionToolGrantDecision;
  } => {
    const projectId = call.thread.projectId;
    const subject =
      projectId === undefined
        ? undefined
        : {
            projectId,
            extensionId: call.extensionId,
            packageId: call.packageId,
            componentId: call.componentId,
            mcpToolName: call.mcpToolName,
          };
    const stored = subject === undefined ? undefined : options.grants.read(subject);
    return {
      subject,
      decision: decideExtensionToolGrant({
        inProject: subject !== undefined,
        hostOwnedTurn: call.windowId !== undefined && options.isHostScope(call.windowId),
        planTurn: call.thread.planTurn === true,
        threadTainted: options.threadTainted(call.thread.id),
        reach: call.reach,
        offered: offeredBinding(call),
        grant:
          stored === undefined
            ? undefined
            : {
                version: stored.version,
                digest: stored.digest,
                definitionDigest: stored.definitionDigest,
                revoked: stored.revocationReason !== undefined,
              },
      }),
    };
  };

  // Judged again when the person answers: the prompt may have been open while
  // another call brought outside content onto the thread, and what was
  // rememberable when it was raised is then approved for that call alone.
  const remember = (call: ExtensionToolCall): boolean => {
    const { subject, decision } = judge(call);
    if (decision.kind === "covered") return true;
    if (subject === undefined || !decision.rememberable) return false;
    return options.grants.record({ ...subject, ...offeredBinding(call) }) === "recorded";
  };

  return async (call) => {
    const { decision } = judge(call);
    if (decision.kind === "covered") return true;
    // A turn nobody is sitting at may use a grant but cannot raise a prompt.
    if (call.windowId === undefined) return false;
    const outsideContent = options.outsideContent?.(call.thread.id);
    return options.approvals.request({
      windowId: call.windowId,
      threadId: call.thread.id,
      ...(call.thread.projectId === undefined ? {} : { projectId: call.thread.projectId }),
      extensionId: call.extensionId,
      packageId: call.packageId,
      componentId: call.componentId,
      serverName: call.serverName,
      providerToolName: call.providerToolName,
      mcpToolName: call.mcpToolName,
      inputJson: call.inputJson,
      ...(outsideContent === undefined ? {} : { outsideContent }),
      ...(decision.rememberable ? { remember: () => remember(call) } : {}),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
  };
}

function offeredBinding(call: ExtensionToolCall) {
  return {
    version: call.version,
    digest: call.digest,
    definitionDigest: call.definitionDigest,
  };
}
