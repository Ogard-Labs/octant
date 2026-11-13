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
 * Decides whether an MCP tool call may run: a thread at Full access runs it
 * unasked, a remembered approval for its whole server or for exactly this
 * tool covers it, and otherwise a person is asked in the turn's window. Below
 * Full access a server asks once: the approval of its first prompt is
 * recorded for every tool of the server. A thread in a Project reads and
 * records that Project's grants; a thread outside one reads and records the
 * account's. A grant is recorded only from a person's approval of that
 * prompt, so nothing a model, a tool, or a route sends can create one.
 *
 * On a thread that has taken in outside content a network server asks once
 * more, and that approval holds for the server on that thread alone. It is
 * journaled beside the grants, so a restarted host does not ask that thread
 * again, and it ends when the package's grants end.
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
  /**
   * The publisher key whose signature of one retained package version the
   * host verified, or `undefined` for an unsigned one. An update signed by
   * the key that signed the approved version keeps the approval.
   */
  readonly verifiedPublisherKey?: (version: {
    readonly extensionId: string;
    readonly version: string;
    readonly digest: string;
  }) => string | undefined;
  /**
   * The run of same-source updates one retained, unsigned package version
   * belongs to, or `undefined` outside any. An approval given to one version
   * of a run holds for the later ones.
   */
  readonly updateLine?: (version: {
    readonly extensionId: string;
    readonly version: string;
    readonly digest: string;
  }) => string | undefined;
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
    const storedForThread = options.grants.read({ ...server, threadId: call.thread.id });
    const signedBy = (version: { readonly version: string; readonly digest: string }) => {
      const retained = {
        extensionId: call.extensionId,
        version: version.version,
        digest: version.digest,
      };
      const publisherKey = options.verifiedPublisherKey?.(retained);
      const updateLine = options.updateLine?.(retained);
      return {
        ...(publisherKey === undefined ? {} : { publisherKey }),
        ...(updateLine === undefined ? {} : { updateLine }),
      };
    };
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
        offered: { ...offeredBinding(call), ...signedBy(call) },
        // A tool's row always carries its listing digest; the payload schema
        // refuses a tool name without one.
        grant:
          stored?.definitionDigest === undefined
            ? undefined
            : {
                version: stored.version,
                digest: stored.digest,
                definitionDigest: stored.definitionDigest,
                ...signedBy(stored),
                revoked: stored.revocationReason !== undefined,
              },
        serverGrant:
          storedForServer === undefined
            ? undefined
            : {
                version: storedForServer.version,
                digest: storedForServer.digest,
                ...signedBy(storedForServer),
                revoked: storedForServer.revocationReason !== undefined,
              },
        markedThreadAnswer:
          storedForThread === undefined
            ? undefined
            : {
                version: storedForThread.version,
                digest: storedForThread.digest,
                ...signedBy(storedForThread),
                revoked: storedForThread.revocationReason !== undefined,
              },
      }),
    };
  };

  // Judged again when the person answers: the prompt may have been open while
  // another call brought outside content onto the thread, and what would have
  // been kept for the Project when it was raised is then kept for the thread.
  const remember = (call: ExtensionToolCall, scope: "tool" | "server"): boolean => {
    const { server, decision } = judge(call);
    if (decision.kind === "covered") return true;
    if (decision.answerCovers !== "server") return false;
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

  // Only the local window whose own turn raised a prompt can answer one whose
  // approval is kept: a host-owned or a paired device's turn is judged to
  // cover its call alone. An answer that already narrowed itself to this tool
  // is judged covered here and records nothing wider.
  const keepApproval = (call: ExtensionToolCall): void => {
    const { server, decision } = judge(call);
    if (decision.kind === "covered") return;
    if (decision.answerCovers === "server") {
      // A grant the journal refuses leaves this call approved and the next asked.
      options.grants.record({ ...server, version: call.version, digest: call.digest });
    } else if (decision.answerCovers === "server-on-thread") {
      options.grants.record({
        ...server,
        threadId: call.thread.id,
        version: call.version,
        digest: call.digest,
      });
    }
  };

  return async (call) => {
    const { decision } = judge(call);
    if (decision.kind === "covered") return true;
    // A turn nobody is sitting at may use a grant but cannot raise a prompt.
    if (call.windowId === undefined) return false;
    const outsideContent = options.outsideContent?.(call.thread.id);
    const approved = await options.approvals.request({
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
      answerCovers: decision.answerCovers,
      ...(decision.answerCovers === "server"
        ? { remember: (scope: "tool" | "server") => remember(call, scope) }
        : {}),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
    if (approved) keepApproval(call);
    return approved;
  };
}

function offeredBinding(call: ExtensionToolCall) {
  return {
    version: call.version,
    digest: call.digest,
    definitionDigest: call.definitionDigest,
  };
}
