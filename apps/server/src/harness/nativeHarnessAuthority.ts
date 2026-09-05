import type {
  ChatThreadId,
  OctantMode,
  ThreadExternalContentTaint,
  ToolActionAuthority,
  ToolHostId,
} from "@octant/contracts";
import { ServerBrowserAuthorityResolver } from "../browser/browserAuthorityResolver";
import type { PersistenceService } from "../persistence/persistenceService";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import type { WorkThreadProjection } from "../work/workThreadProjection";

export interface NativeHarnessAuthorityOptions {
  readonly hostId: ToolHostId;
  readonly persistence: Pick<
    PersistenceService,
    "readProject" | "readCodeThread" | "readProviderInstance" | "readChatThread"
  >;
  readonly workThreads: Pick<WorkThreadProjection, "read">;
  readonly readThreadTaint: (threadId: string) => ThreadExternalContentTaint;
  readonly clock?: () => string;
}

export interface NativeHarnessAuthority {
  /** The authority a thread holds right now, or nothing when it speaks for nothing. */
  readonly resolve: (threadId: string, mode: OctantMode) => ToolActionAuthority | undefined;
  readonly service: ToolCallAuthorityService;
}

/**
 * The harness's view of the single authority choke point.
 *
 * Granted authority comes from the thread's own durable record — a Chat
 * thread's Project, a Work thread's bound root, a Code thread's checkout — and
 * the live facts the policy needs come from the same records plus the taint
 * projection. Nothing is taken from the model's request.
 */
export function createNativeHarnessAuthority(
  options: NativeHarnessAuthorityOptions,
): NativeHarnessAuthority {
  const resolver = new ServerBrowserAuthorityResolver({
    hostId: options.hostId,
    persistence: options.persistence,
    workThreads: options.workThreads,
  });
  const resolve = (threadId: string, mode: OctantMode): ToolActionAuthority | undefined => {
    if (mode !== "chat") return resolver.resolve(threadId as never, mode);
    const thread = options.persistence.readChatThread(threadId as ChatThreadId);
    if (thread === undefined || thread.lifecycle !== "active" || thread.projectId === undefined) {
      return undefined;
    }
    const provider = options.persistence.readProviderInstance(thread.providerInstanceId);
    if (provider?.enabled !== true) return undefined;
    return {
      hostId: options.hostId,
      mode,
      projectId: thread.projectId,
      providerInstanceId: thread.providerInstanceId,
      extension: { kind: "core" },
    };
  };
  const service = new ToolCallAuthorityService({
    resolveGrantedAuthority: (threadId, mode) => resolve(threadId, mode),
    resolveLiveFacts: ({ threadId, mode }) => {
      const code =
        mode === "code" ? options.persistence.readCodeThread(threadId as never) : undefined;
      const executionPolicy = code?.executionPolicy ?? "approval-gated";
      return {
        // The harness is only composed for a provider that runs app-managed
        // tools; a provider that cannot never reaches this service.
        providerAppManagedTools: "supported",
        host: { computerUseEnabled: false },
        executionPolicy,
        approvalSatisfied: executionPolicy === "full-access",
        externalContentIngested: options.readThreadTaint(threadId).externalContentIngested,
        ...(code?.toolConstraints === undefined ? {} : { toolConstraints: code.toolConstraints }),
        ...(code?.profileDisplayName === undefined
          ? {}
          : { profileDisplayName: code.profileDisplayName }),
      };
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return { resolve, service };
}
