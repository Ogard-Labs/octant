import { LOCAL_HOST_ID } from "@octant/contracts";
import type {
  OctantMode,
  WorkAccess,
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
  /**
   * The access a Work thread's running turn holds. A goal-loop round can run
   * ask-first on an auto-accept thread; edits answer to the round, not the
   * thread. Without it, or with no turn running, Work edits ask first.
   */
  readonly runningWorkTurnAccess?: (threadId: string) => WorkAccess | undefined;
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
 * thread and its Project when it has one, a Work thread's bound root, a Code
 * thread's checkout — and the live facts the policy needs come from the same
 * records plus the taint projection. Nothing is taken from the model's request.
 */
export function createNativeHarnessAuthority(
  options: NativeHarnessAuthorityOptions,
): NativeHarnessAuthority {
  const resolver = new ServerBrowserAuthorityResolver({
    hostId: options.hostId,
    workspaceHostId: LOCAL_HOST_ID,
    persistence: options.persistence,
    workThreads: options.workThreads,
  });
  // Chat resolves through the same resolver as Work and Code. A Chat thread
  // needs no Project to hold authority: most new Chat threads have none, and
  // requiring one refused every harness tool call on them as stale.
  const resolve = (threadId: string, mode: OctantMode): ToolActionAuthority | undefined =>
    resolver.resolve(threadId as never, mode);
  const service = new ToolCallAuthorityService({
    resolveGrantedAuthority: (threadId, mode) => resolve(threadId, mode),
    resolveLiveFacts: ({ threadId, mode }) => {
      const code =
        mode === "code" ? options.persistence.readCodeThread(threadId as never) : undefined;
      // A Work turn's access is the running turn's: the thread's own, or
      // ask-first when a goal-loop round's ceiling is narrower. Auto-accept
      // lets the harness write project files without asking, as it does for a
      // Code thread; anything else, including no turn at all, asks.
      const workAccess = mode === "work" ? options.runningWorkTurnAccess?.(threadId) : undefined;
      const executionPolicy =
        code?.executionPolicy ??
        (workAccess === "auto-accept-edits" ? "auto-accept-edits" : "approval-gated");
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
