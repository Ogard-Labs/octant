import {
  decodeNativeHarnessContextRemaining,
  type ChatThread,
  type CodeThread,
  type ContextSubjectRef,
  type NativeHarnessContextRemaining,
  type ProviderInstanceId,
  type WorkThread,
} from "@octant/contracts";
import type { ContextHarnessService } from "../context/contextHarnessService";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { PlanService } from "../plan/planService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import type { NativeHarnessAuthority } from "./nativeHarnessAuthority";
import { NativeHarnessFileSystem } from "./nativeHarnessFileSystem";
import { createNativeHarnessTodoPort } from "./nativeHarnessTodo";
import {
  createNativeHarnessTools,
  type NativeHarnessShellPort,
  type NativeHarnessToolPorts,
} from "./nativeHarnessTools";

export interface NativeHarnessCompositionOptions {
  readonly authority: NativeHarnessAuthority;
  /** Whether a provider instance is one the harness drives; others get no harness tools. */
  readonly isHarnessProvider: (providerInstanceId: ProviderInstanceId) => boolean;
  readonly plans?: Pick<PlanService, "read" | "execute">;
  /** Code only: the sandboxed shell. */
  readonly shell?: NativeHarnessShellPort;
  readonly webSearch?: NativeHarnessToolPorts["webSearch"];
  readonly webFetch?: NativeHarnessToolPorts["webFetch"];
  readonly contextHarness?: Pick<ContextHarnessService, "inspect">;
  readonly recordExternalContentIngestion: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export interface NativeHarnessComposition {
  readonly forChat: (thread: ChatThread) => AppManagedToolSet | undefined;
  readonly forWork: (input: {
    readonly thread: WorkThread;
    readonly projectRoot: string;
  }) => AppManagedToolSet | undefined;
  readonly forCode: (input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
  }) => AppManagedToolSet | undefined;
}

/**
 * Composes the harness tool set for one thread in one mode. The mode decides
 * the root and the ports; the catalog decides which tools exist in that mode;
 * the authority service decides each call. Every result is tainted before it
 * reaches the next model turn, like any other app-managed tool.
 */
export function createNativeHarnessComposition(
  options: NativeHarnessCompositionOptions,
): NativeHarnessComposition {
  const contextRemaining =
    options.contextHarness === undefined
      ? undefined
      : (subject: ContextSubjectRef) => (): NativeHarnessContextRemaining | undefined => {
          try {
            const snapshot = options.contextHarness!.inspect(subject);
            const plan = snapshot.next.plan;
            const used = Math.min(plan.plannedInputTokens, plan.safeInputBudget);
            return decodeNativeHarnessContextRemaining({
              safeInputBudgetTokens: plan.safeInputBudget,
              usedTokens: used,
              remainingTokens: plan.safeInputBudget - used,
              confidence: snapshot.modelLimits.confidence,
              source: "capacity-planner",
              measuredAt: snapshot.snapshotAt,
            });
          } catch {
            return undefined;
          }
        };
  const shared = (threadId: string): NativeHarnessToolPorts => ({
    ...(options.webFetch === undefined ? {} : { webFetch: options.webFetch }),
    ...(options.plans === undefined
      ? {}
      : {
          todo: createNativeHarnessTodoPort({ plans: options.plans, threadId, uuid: options.uuid }),
        }),
  });
  const compose = (input: {
    readonly threadId: string;
    readonly mode: "chat" | "work" | "code";
    readonly ports: NativeHarnessToolPorts;
  }): AppManagedToolSet =>
    taintAppManagedToolResults({
      tools: createNativeHarnessTools({
        threadId: input.threadId,
        mode: input.mode,
        authority: options.authority.service,
        resolveAuthority: () => options.authority.resolve(input.threadId, input.mode),
        ports: input.ports,
        uuid: options.uuid,
      }),
      threadId: input.threadId,
      recordExternalContentIngestion: options.recordExternalContentIngestion,
      uuid: options.uuid,
    });
  return {
    forChat: (thread) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
      return compose({
        threadId,
        mode: "chat",
        ports: {
          ...shared(threadId),
          // Research is the user's grant for a Chat thread to reach the web.
          ...(thread.researchEnabled && options.webSearch !== undefined
            ? { webSearch: options.webSearch }
            : {}),
          ...(contextRemaining === undefined
            ? {}
            : {
                contextRemaining: contextRemaining({
                  aggregateType: "chat-thread" as never,
                  aggregateId: threadId as never,
                }),
              }),
        },
      });
    },
    forWork: ({ thread, projectRoot }) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
      return compose({
        threadId,
        mode: "work",
        ports: {
          ...shared(threadId),
          filesystem: new NativeHarnessFileSystem({ root: projectRoot }),
          ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
        },
      });
    },
    forCode: ({ thread, checkoutRoot }) => {
      if (!options.isHarnessProvider(thread.providerInstanceId)) return undefined;
      const threadId = String(thread.id);
      return compose({
        threadId,
        mode: "code",
        ports: {
          ...shared(threadId),
          filesystem: new NativeHarnessFileSystem({ root: checkoutRoot }),
          ...(options.shell === undefined ? {} : { shell: options.shell }),
          ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
        },
      });
    },
  };
}
