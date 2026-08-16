import type {
  AgentRunAuthority,
  ChatThread,
  ChatThreadView,
  ChatThreadId,
  EventActor,
  LinkedThreadLimitSnapshot,
  LinkedThreadPromptPreviewCommand,
  LinkedThreadRoutingReceipt,
  LinkedThreadTargetThreadId,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts";
import { decodeChatThreadId } from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY,
  selectLinkedThreadRoute,
  type LinkedThreadRouteCandidate,
} from "@octant/domain";
import type { ChatService } from "../chat/chatService";
import { LinkedThreadService } from "./linkedThreadService";

export interface LinkedThreadRuntimeOptions {
  readonly actor: EventActor;
  readonly chat: Pick<ChatService, "execute">;
  /**
   * Read the authoritative Chat view so linked-thread provenance compares
   * against the aggregate-head version exposed to the renderer, not the raw
   * projection version.
   */
  readonly readChatThreadView: (
    threadId: ChatThreadId,
  ) => Pick<ChatThreadView, "thread"> | undefined;
  readonly authorityCeiling?: AgentRunAuthority;
}

function sourceThreadFor(
  options: LinkedThreadRuntimeOptions,
  command: LinkedThreadPromptPreviewCommand,
): ChatThread | undefined {
  if (command.sourceScope.mode !== "chat" || command.targetScope.mode !== "chat") return undefined;
  if (
    command.sourceScope.hostId !== LOCAL_HOST_ID ||
    command.targetScope.hostId !== LOCAL_HOST_ID ||
    command.sourceScope.workspace.kind !== "chat-virtual" ||
    command.targetScope.workspace.kind !== "chat-virtual"
  ) {
    return undefined;
  }
  const source = options.readChatThreadView(decodeChatThreadId(command.sourceThreadId))?.thread;
  if (source === undefined || source.lifecycle !== "active") return undefined;
  if (source.version !== command.sourceVersion) return undefined;
  if (
    (source.projectId ?? null) !== (command.sourceScope.workspace.projectId ?? null) ||
    (source.projectId ?? null) !== (command.targetScope.workspace.projectId ?? null)
  ) {
    return undefined;
  }
  return source;
}

export function createLinkedThreadRuntime(
  options: LinkedThreadRuntimeOptions,
): LinkedThreadService {
  const authority = options.authorityCeiling ?? LINKED_THREAD_REVIEW_ISOLATED_AUTHORITY;
  const routeFor = (command: LinkedThreadPromptPreviewCommand) => {
    const source = sourceThreadFor(options, command);
    if (source === undefined) return undefined;
    const candidate: LinkedThreadRouteCandidate = {
      providerInstanceId: String(source.providerInstanceId),
      modelId: String(source.modelId),
      executionPolicy: authority.executionPolicy,
      permissionPersistence: authority.permissionPersistence,
      capabilities: {
        filesystem: authority.filesystem,
        shell: authority.shell,
        git: authority.git,
        network: authority.network,
        tools: authority.tools,
        subagents: authority.subagents,
      },
    };
    return { source, candidate };
  };

  return new LinkedThreadService({
    creation: {
      create: async ({ authenticatedWindowId, preview, targets }) => {
        if (preview.targetScope.mode !== "chat") {
          return targets.map((target) => ({
            targetIndex: target.targetIndex,
            label: target.label,
            status: "rejected" as const,
            reason: "Parallel review execution is currently available for Chat threads only.",
          }));
        }
        const projectId =
          preview.targetScope.workspace.kind === "chat-virtual"
            ? (preview.targetScope.workspace.projectId ?? undefined)
            : undefined;
        const results = [];
        for (const target of targets) {
          let createdThreadId: LinkedThreadTargetThreadId | undefined;
          try {
            const created = await options.chat.execute({
              kind: "create-chat-thread",
              threadId: decodeChatThreadId(target.threadId),
              hostId: preview.targetScope.hostId,
              ...(projectId === undefined ? {} : { projectId }),
              title: target.label,
            });
            if (created.kind !== "thread-created") throw new Error("thread creation failed");
            createdThreadId = target.threadId;
            let thread = created.thread;
            if (
              thread.providerInstanceId !== preview.routingReceipt.selectedProviderInstanceId ||
              thread.modelId !== preview.routingReceipt.selectedModelId
            ) {
              const changed = await options.chat.execute({
                kind: "change-chat-provider",
                threadId: thread.id,
                expectedVersion: thread.version,
                providerInstanceId: preview.routingReceipt.selectedProviderInstanceId,
                modelId: preview.routingReceipt.selectedModelId,
              });
              if (changed.kind !== "thread-updated") throw new Error("provider selection failed");
              thread = changed.thread;
            }
            await options.chat.execute(
              {
                kind: "send-chat-turn",
                threadId: thread.id,
                expectedVersion: thread.version,
                prompt: target.prompt,
              },
              { windowId: authenticatedWindowId },
            );
            results.push({
              targetIndex: target.targetIndex,
              label: target.label,
              status: "created" as const,
              threadId: target.threadId,
              resultRefId: `chat-thread:${String(target.threadId)}`,
            });
          } catch {
            results.push({
              targetIndex: target.targetIndex,
              label: target.label,
              status: "failed" as const,
              ...(createdThreadId === undefined ? {} : { threadId: createdThreadId }),
              ...(createdThreadId === undefined
                ? {}
                : { resultRefId: `chat-thread:${String(createdThreadId)}` }),
              reason: "The linked Chat review thread could not be started.",
            });
          }
        }
        return results;
      },
    },
    selectRoute: (command) => {
      const resolved = routeFor(command);
      if (resolved === undefined) {
        return { kind: "denied", reason: "The source Chat thread route is unavailable or stale." };
      }
      return selectLinkedThreadRoute({
        requestedAuthority: command.requestedAuthority,
        ...(command.requestedModelId === undefined
          ? {}
          : { requestedModelId: command.requestedModelId }),
        ...(command.requestedProviderInstanceId === undefined
          ? {}
          : { requestedProviderInstanceId: command.requestedProviderInstanceId }),
        primary: resolved.candidate,
        fallbackChain: [],
      });
    },
    routingReceiptFor: (command): LinkedThreadRoutingReceipt => {
      const resolved = routeFor(command);
      if (resolved === undefined) {
        throw new Error("The source Chat thread route is unavailable or stale.");
      }
      const providerInstanceId = resolved.source.providerInstanceId as ProviderInstanceId;
      const modelId = resolved.source.modelId as ProviderModelId;
      const source = resolved.source.projectId === undefined ? "mode-default" : "project-default";
      return {
        executionResolution: {
          providerInstanceId,
          modelId,
          hostId: LOCAL_HOST_ID,
          executionPolicy: authority.executionPolicy,
          permissionPersistence: authority.permissionPersistence,
          effectivePermissions: {
            filesystem: authority.filesystem,
            shell: authority.shell,
            git: authority.git,
            network: authority.network,
            tools: authority.tools,
            subagents: authority.subagents,
          },
          source,
          fallbackChain: [source],
          downgradeReasons: [],
        },
        selectedProviderInstanceId: providerInstanceId,
        selectedModelId: modelId,
        fallbackCandidates: [],
        capabilityDegradations: [],
        contextSnapshotId: command.contextSnapshotId,
        effectiveAuthorityDigest: "linked-thread-review-read-only-v1",
        hostId: LOCAL_HOST_ID,
        mode: "chat",
        ...(resolved.source.projectId === undefined
          ? {}
          : { projectId: resolved.source.projectId }),
      };
    },
    limitsFor: (input): LinkedThreadLimitSnapshot => {
      const resolved = routeFor(input.command);
      if (resolved === undefined) {
        return {
          requestedCount: input.requestedCount,
          nestingDepth: input.command.nestingDepth,
          activeGlobal: 0,
          activeForSource: 0,
          activeForProject: 0,
          activeForHost: 0,
          providerCapacity: {
            status: "unavailable",
            providerInstanceId: (input.command.requestedProviderInstanceId ??
              "00000000-0000-4000-8000-000000000000") as ProviderInstanceId,
          },
        };
      }
      return {
        requestedCount: input.requestedCount,
        nestingDepth: input.command.nestingDepth,
        activeGlobal: 0,
        activeForSource: 0,
        activeForProject: 0,
        activeForHost: 0,
        providerCapacity: {
          status: "available",
          providerInstanceId: resolved.source.providerInstanceId,
          active: 0,
          limit: 4,
          remaining: 4,
        },
      };
    },
    authorityCeiling: authority,
    targetAuthorityCeiling: authority,
    actor: options.actor,
  });
}
