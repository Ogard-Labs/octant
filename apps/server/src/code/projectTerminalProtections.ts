import type { SandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import type { ProviderExecutionPolicy } from "@octant/contracts";
import type {
  ProviderRuntimeNetworkPort,
  ProviderRuntimeNetworkStart,
} from "../network/providerRuntimeNetwork";
import {
  beginSandboxTurn,
  registerSandboxCleanup,
  sandboxSelectionIsCurrent,
} from "../process/sandboxRuntimePolicy";
import type { TerminalLaunchRequest } from "./terminalService";

export type ProjectTerminalProtection =
  | { readonly status: "refused"; readonly message: string }
  | {
      readonly status: "admitted";
      readonly managed: boolean;
      readonly launch: Pick<
        TerminalLaunchRequest,
        "sandboxPolicy" | "strict" | "networkEgress" | "environment"
      >;
      readonly current: () => boolean;
      readonly end: () => Promise<void>;
    };

/** Personal terminals own a scope; a Work terminal also inherits its thread's ceiling. */
export async function prepareProjectTerminalProtections(
  input: {
    readonly terminalId: string;
    readonly projectId: string;
    readonly root: string;
    readonly mode: "code" | "work";
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly workThreadId?: string;
  },
  network: ProviderRuntimeNetworkPort | undefined,
): Promise<ProjectTerminalProtection> {
  const admitted = beginSandboxTurn({
    threadId: input.terminalId,
    projectId: input.projectId,
    root: input.root,
    mode: input.mode,
    provider: "terminal",
    executionRoute: "terminal",
    ...(input.workThreadId === undefined ? {} : { parentThreadId: input.workThreadId }),
  });
  if (admitted.status === "refused") return admitted;
  const turn = admitted.turn;
  const selection: SandboxPolicySelection | undefined = turn.selection;
  let proxy: Extract<ProviderRuntimeNetworkStart, { readonly status: "proxied" }> | undefined;
  let leaveNetwork: (() => void) | undefined;
  let cleanup: Promise<void> | undefined;
  const end = () =>
    (cleanup ??= (async () => {
      await proxy?.release();
      leaveNetwork?.();
      await turn.end();
    })().catch((error: unknown) => {
      cleanup = undefined;
      throw error;
    }));
  try {
    if (selection !== undefined) {
      if (network === undefined) {
        await end();
        return {
          status: "refused",
          message: "The terminal's scoped network broker is unavailable.",
        };
      }
      const started = await network.start({
        runtime: "terminal",
        root: input.root,
        executionPolicy: input.executionPolicy,
        sandboxPolicy: selection,
      });
      if (started.status === "refused") {
        await end();
        return started;
      }
      if (started.status === "proxied") {
        proxy = started;
        leaveNetwork = registerSandboxCleanup(selection, started.release);
      }
    }
    return {
      status: "admitted",
      managed: turn.strict !== undefined,
      launch: {
        ...(turn.strict === undefined ? {} : { strict: turn.strict }),
        ...(selection === undefined ? {} : { sandboxPolicy: selection }),
        ...(proxy === undefined
          ? {}
          : {
              networkEgress: { kind: "proxied", endpoint: proxy.endpoint },
              environment: proxy.environment,
            }),
      },
      current: () =>
        turn.current() && (selection === undefined || sandboxSelectionIsCurrent(selection)),
      end,
    };
  } catch (error) {
    await end();
    throw error;
  }
}
