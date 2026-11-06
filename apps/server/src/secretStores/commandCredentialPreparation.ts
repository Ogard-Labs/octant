import { realpath } from "node:fs/promises";
import {
  AggregateId,
  ToolEgressLaunchId,
  decodeCodeThreadId,
  type CodeThread,
  type CodeThreadId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { CommandCredentialBinding } from "@octant/contracts/command-credentials";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import type { ToolEgressRules } from "../harness/nativeHarnessEgressRules";
import type { ToolEgressProxyEndpointRequest } from "../harness/nativeHarnessEgressProxy";
import { proxiedLaunchEnvironment } from "../process/proxiedNetworkEgress";
import { confinedCommandCredentialProcess } from "./confinedCommandCredentialProcess";
import type { CommandCredentialContext } from "./commandCredentialBindings";
import type { PreparedCredentialCommand } from "./commandCredentialExecution";

/** Ordinary Code policy and egress are additional to one-use credential consent. */
export function createCommandCredentialPreparation(options: {
  readonly readThread: (id: CodeThreadId) => CodeThread | undefined;
  readonly ordinary: Pick<NativeHarnessComposition, "prepareCodeCommand">;
  readonly egress: Pick<ToolEgressRules, "startLaunch">;
  readonly endpoint: ToolEgressProxyEndpointRequest | undefined;
  readonly fullAccessProcess: PreparedCredentialCommand["process"];
  readonly temporaryDirectory: string;
  readonly receiptDirectory: string;
  readonly uuid: () => string;
}) {
  const decodeEgressAggregateId = Schema.decodeUnknownSync(AggregateId);
  const decodeEgressLaunchId = Schema.decodeUnknownSync(ToolEgressLaunchId);
  return async ({
    binding,
    context,
    recipientIdentity,
    signal,
  }: {
    readonly binding: CommandCredentialBinding;
    readonly context: CommandCredentialContext;
    readonly recipientIdentity: string;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly status: "admitted"; readonly command: PreparedCredentialCommand }
    | { readonly status: "refused" }
  > => {
    const thread = options.readThread(decodeCodeThreadId(context.threadId));
    if (thread === undefined || !context.current() || signal.aborted) return { status: "refused" };
    // Quoting is solely for the existing policy/reviewer; this text is never executed.
    const commandText = [binding.definition.executable, ...binding.definition.args]
      .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
      .join(" ");
    const policy = await options.ordinary.prepareCodeCommand({
      thread,
      checkoutRoot: context.root,
      windowId: context.windowId,
      command: commandText,
      signal,
    });
    if (policy.status === "refused") return { status: "refused" };
    let live: Awaited<ReturnType<typeof options.egress.startLaunch>> | undefined;
    let finished: Promise<boolean> | undefined;
    const finish: PreparedCredentialCommand["finish"] = (result) =>
      (finished ??= (async () => {
        let networkRecorded = true;
        if (live?.status === "listening") {
          try {
            networkRecorded = (await live.launch.finish()).status === "summarized";
          } catch {
            networkRecorded = false;
          }
        }
        let policyRecorded = false;
        try {
          policyRecorded = policy.finish(result) !== "unavailable";
        } catch {
          policyRecorded = false;
        }
        return networkRecorded && policyRecorded;
      })());
    try {
      if (!context.current() || signal.aborted) {
        await finish({ started: false });
        return { status: "refused" };
      }
      if (context.executionPolicy === "full-access")
        return {
          status: "admitted",
          command: {
            mode: "full-access",
            process: options.fullAccessProcess,
            environment: {},
            admitStart: policy.admitStart,
            finish,
          },
        };
      if (options.endpoint === undefined) {
        await finish({ started: false });
        return { status: "refused" };
      }
      live = await options.egress.startLaunch({
        launch: {
          launchId: decodeEgressLaunchId(options.uuid()),
          threadId: decodeEgressAggregateId(context.threadId),
          projectId: decodeEgressAggregateId(context.projectId),
          toolCallId: policy.callId,
        },
        endpoint: options.endpoint,
        confirmed: policy.confirmedHosts,
      });
      if (live.status === "refused") {
        await finish({ started: false });
        return { status: "refused" };
      }
      const proxy = live.launch.proxy;
      const proxyUrl = proxiedLaunchEnvironment(proxy.endpoint, proxy.token).HTTP_PROXY;
      if (proxyUrl === undefined) {
        await finish({ started: false });
        return { status: "refused" };
      }
      const confined = confinedCommandCredentialProcess({
        binding,
        recipientIdentity,
        checkoutRoot: await realpath(context.root),
        networkEgress: { kind: "proxied", endpoint: proxy.endpoint },
        proxyUrl,
        temporaryDirectory: options.temporaryDirectory,
        receiptDirectory: options.receiptDirectory,
      });
      return {
        status: "admitted",
        command: {
          mode: "confined",
          process: confined.process,
          environment: confined.environment,
          admitStart: policy.admitStart,
          finish,
        },
      };
    } catch {
      await finish({ started: false });
      return { status: "refused" };
    }
  };
}
