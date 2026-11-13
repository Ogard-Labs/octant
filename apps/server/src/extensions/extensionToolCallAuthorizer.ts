import {
  decideExtensionToolGrant,
  type ExtensionToolGrantDecision,
} from "@octant/domain/extension-tool-grant-policy";
import type { ApprovalOutsideContent, WindowId } from "@octant/contracts";
import type { ExtensionToolGrantSubject } from "../persistence/extensionToolGrantProjection";
import type { ExtensionToolCall } from "./agentPluginMcpSessionManager";
import type { ExtensionToolApprovalService } from "./extensionToolApprovalService";
import type { ExtensionToolGrantStore } from "./extensionToolGrantStore";
import { whileAwaitingToolApproval } from "../toolEffects/toolEffectLedger";

/**
 * Decides whether an MCP tool call may run: a thread at Full access runs it
 * unasked, a remembered approval for exactly this tool or for its whole
 * server covers it, and otherwise a person is asked in the turn's window. A
 * thread in a Project reads and records that Project's grants; a thread
 * outside one reads and records the account's. A grant is recorded only from
 * inside that prompt's answer, so nothing a model, a tool, or a route sends
 * can create one.
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
  /**
   * Whether the scope a turn runs under is a paired device's. Such a turn's
   * prompt is approved once and never remembered, whoever answers it.
   */
  readonly isPairedDeviceScope: (windowId: WindowId) => boolean;
  /** Whether the thread has taken in outside content, from the journal's taint. */
  readonly threadTainted: (threadId: string) => boolean;
  /** The sources that marked the thread, which its prompt names. */
  readonly outsideContent?: (threadId: string) => ApprovalOutsideContent | undefined;
}): (call: ExtensionToolCall) => Promise<boolean> {
  const judge = (
    call: ExtensionToolCall,
  ): {
    readonly server: ExtensionToolGrantSubject;
    readonly decision: ExtensionToolGrantDecision;
  } => {
    const server = {
      projectId: call.thread.projectId,
      extensionId: call.extensionId,
      packageId: call.packageId,
      componentId: call.componentId,
    };
    const stored = options.grants.read({ ...server, mcpToolName: call.mcpToolName });
    const storedForServer = options.grants.read(server);
    return {
      server,
      decision: decideExtensionToolGrant({
        inProject: call.thread.projectId !== undefined,
        hostOwnedTurn: call.windowId !== undefined && options.isHostScope(call.windowId),
        pairedDeviceTurn: call.windowId !== undefined && options.isPairedDeviceScope(call.windowId),
        planTurn: call.thread.planTurn === true,
        fullAccessTurn: call.thread.fullAccessTurn === true,
        threadTainted: options.threadTainted(call.thread.id),
        reach: call.reach,
        ...(call.askEveryCall === true ? { askEveryCall: true } : {}),
        offered: offeredBinding(call),
        // A tool's row always carries its listing digest; the payload schema
        // refuses a tool name without one.
        grant:
          stored?.definitionDigest === undefined
            ? undefined
            : {
                version: stored.version,
                digest: stored.digest,
                definitionDigest: stored.definitionDigest,
                revoked: stored.revocationReason !== undefined,
              },
        serverGrant:
          storedForServer === undefined
            ? undefined
            : {
                version: storedForServer.version,
                digest: storedForServer.digest,
                revoked: storedForServer.revocationReason !== undefined,
              },
      }),
    };
  };

  // Judged again when the person answers: the prompt may have been open while
  // another call brought outside content onto the thread, and what was
  // rememberable when it was raised is then approved for that call alone.
  const remember = (call: ExtensionToolCall, scope: "tool" | "server"): boolean => {
    const { server, decision } = judge(call);
    if (decision.kind === "covered") return true;
    if (!decision.rememberable) return false;
    const recorded =
      scope === "server"
        ? options.grants.record({ ...server, version: call.version, digest: call.digest })
        : options.grants.record({
            ...server,
            mcpToolName: call.mcpToolName,
            ...offeredBinding(call),
          });
    return recorded === "recorded";
  };

  return async (call) => {
    const { decision } = judge(call);
    if (decision.kind === "covered") return true;
    // A turn nobody is sitting at may use a grant but cannot raise a prompt.
    if (call.windowId === undefined) return false;
    const outsideContent = options.outsideContent?.(call.thread.id);
    const { windowId } = call;
    // Asked before the server is called: while it waits, the call's record
    // says nothing ran, so a restart continues the turn and asks again.
    return whileAwaitingToolApproval(() =>
      options.approvals.request({
        windowId,
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
        ...(decision.rememberable
          ? { remember: (scope: "tool" | "server") => remember(call, scope) }
          : {}),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      }),
    );
  };
}

function offeredBinding(call: ExtensionToolCall) {
  return {
    version: call.version,
    digest: call.digest,
    definitionDigest: call.definitionDigest,
  };
}
