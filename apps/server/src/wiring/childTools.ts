import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { decodeCodeThreadId, type CodeThread } from "@octant/contracts";
import { defaultShellSettings } from "@octant/domain";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { deriveToolHostId } from "../browser/browserAuthorityResolver";
import { approvalPrompt } from "../code/codeOperationRuntime";
import { terminalShellFor } from "../code/terminalShell";
import { githubReadToolSetIfEffective } from "../github/githubIntegrationEffective";
import { hostIconSetsUnder } from "../image/iconSetRenderer";
import { saveGeneratedImageUnder } from "../image/generatedImageSave";
import { workspaceImageSources } from "../image/threadImageSourcePorts";
import { activeSandboxPolicy } from "../process/sandboxRuntimePolicy";
import {
  childCredentialTools,
  childImageTools,
  childMemoryTools,
} from "../agentRun/agentRunChildAskTools";
import {
  childDebugTools,
  childLanguageTools,
  childTerminalTools,
  type ChildCodeToolInput,
} from "../agentRun/agentRunChildCodeTools";
import {
  ChildBootedDeviceLedger,
  childAndroidTools,
  childAppleTools,
  shutDownChildEmulator,
  shutDownChildSimulator,
  type ChildDeviceToolInput,
} from "../agentRun/agentRunChildDevices";
import { childGithubTools, childLookTools } from "../agentRun/agentRunChildReadTools";
import type { AgentRunChildToolHost } from "../agentRun/agentRunChildTools";
import type { CredentialRequests } from "../credentials/credentialRequests";
import type { AgentRunChildToolsInput, AgentRunsWiring } from "./agentRuns";
import type { AuthorityWiring } from "./authority";
import type { CodeToolingWiring } from "./codeTooling";
import type { CodeRuntimeWiring } from "./codeRuntime";
import { supportsConversationInput } from "./conversationInputs";
import type { DevicesWiring } from "./devices";
import type { FoundationsWiring } from "./foundations";
import type { HarnessWiring } from "./harness";
import { modelLabelOf } from "./imageDescriber";
import type { IntegrationsWiring } from "./integrations";
import type { ProvidersWiring } from "./providers";
import type { ServerStart } from "./serverShape";
import type { WorkspaceWiring } from "./workspace";

export type ChildToolsDependencies = Pick<ServerStart, "persistence"> &
  Pick<
    AgentRunsWiring,
    | "childCodeThreads"
    | "childResources"
    | "childToolHost"
    | "contributeChildTools"
    | "externalContentIngestionStore"
  > &
  Pick<AuthorityWiring, "browserCaptures" | "imageGenerationOffers" | "windowAuthorityStore"> &
  Pick<CodeRuntimeWiring, "codeOperationRuntime"> &
  Pick<CodeToolingWiring, "debugService" | "languageService"> &
  Pick<DevicesWiring, "androidToolchainService" | "appleToolchainService" | "recordAppleEvidence"> &
  Pick<FoundationsWiring, "providerRuntimeRegistry" | "resolveThreadStrict"> &
  Pick<HarnessWiring, "imageDescriber"> &
  Pick<
    IntegrationsWiring,
    "credentialOperations" | "githubExtensionSnapshot" | "githubReadToolService"
  > &
  Pick<ProvidersWiring, "imageJobService" | "providerDataDirectory"> &
  Pick<WorkspaceWiring, "keptImageChoices" | "projectMemoryAccess"> & {
    readonly credentialRequests: CredentialRequests;
  };

/**
 * The thread tools a child run inherits, each built again from the child's
 * own run, workspace and level. Every tool a child is not offered here it does
 * not get: the tools that act for a thread itself are never contributed.
 */
export function wireChildTools(deps: ChildToolsDependencies): {
  /** Shuts down devices a child run had booted when an earlier host stopped. */
  readonly settleChildDevices: () => Promise<void>;
} {
  const {
    childCodeThreads,
    childResources,
    contributeChildTools,
    externalContentIngestionStore,
    persistence,
    providerRuntimeRegistry,
  } = deps;
  const hostId = deriveToolHostId(persistence.dataDirectory);
  const record: ChildCodeToolInput["recordExternalContentIngestion"] = (mark) =>
    externalContentIngestionStore.record(mark);
  const tainted = (threadId: string) =>
    readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested;
  const parentThread = (host: AgentRunChildToolHost): CodeThread | undefined => {
    if (host.mode !== "code") return undefined;
    return persistence.readCodeThread(decodeCodeThreadId(host.parentThreadId));
  };
  const codeInput = (host: AgentRunChildToolHost): ChildCodeToolInput => ({
    host,
    threads: childCodeThreads,
    resources: childResources,
    hostId,
    // A child's own marks count beside its parent's.
    externalContentIngested: () => tainted(host.runId) || tainted(host.parentThreadId),
    recordExternalContentIngestion: record,
    uuid: randomUUID,
  });
  const readsImages = ({ target }: AgentRunChildToolHost) =>
    supportsConversationInput(
      providerRuntimeRegistry.observedState(target.providerInstanceId),
      String(target.modelId),
      "image/png",
    );
  const contribute = (
    toolName: string,
    build: (host: AgentRunChildToolHost) => ReturnType<typeof childLookTools>,
  ) =>
    contributeChildTools((input: AgentRunChildToolsInput) => {
      const host = deps.childToolHost(input, toolName);
      return host === undefined ? undefined : build(host);
    });

  contribute("octant_look", (host) =>
    deps.imageDescriber === undefined
      ? undefined
      : childLookTools({
          host,
          describer: deps.imageDescriber,
          threadModel: modelLabelOf(
            { persistence, providerRuntimeRegistry },
            host.target.providerInstanceId,
            host.target.modelId,
          ),
          readsImages: readsImages(host),
          recordExternalContentIngestion: record,
          uuid: randomUUID,
        }),
  );
  contribute("octant_github", (host) =>
    childGithubTools({
      host,
      github: deps.githubReadToolService,
      effective: (create) =>
        githubReadToolSetIfEffective(deps.githubExtensionSnapshot.read(), create),
      readThread: () => parentThread(host),
    }),
  );
  contribute("octant_code", (host) =>
    childLanguageTools({ ...codeInput(host), language: deps.languageService }),
  );
  contribute("octant_memory", (host) =>
    childMemoryTools({ host, memory: deps.projectMemoryAccess }),
  );
  contribute("octant_create_image", (host) =>
    childImageTools({
      host,
      offers: deps.imageGenerationOffers,
      kept: deps.keptImageChoices,
      jobs: deps.imageJobService,
      admitsOutsideImageDriver: (instance) => deps.imageJobService.admitsOutsideDriver(instance),
      listInstances: () => persistence.readProviderInstances(),
      readImageGenerationCustomSources: () =>
        (persistence.readShellSettings()?.settings ?? defaultShellSettings()).imageGeneration
          .customSources,
      defaultProfileInstanceId: () =>
        (persistence.readShellSettings()?.settings ?? defaultShellSettings()).imageGeneration
          .defaultProfileInstanceId,
      readsImages: () => readsImages(host),
      // Only what is the child's own: files of its folder, and its own page's captures.
      imageSources: {
        latestAttachments: () => [],
        ...(host.folder === undefined
          ? {}
          : workspaceImageSources({
              threadId: host.runId as never,
              browserCaptures: deps.browserCaptures,
              root: async () => (host.current() ? host.folder : undefined),
            })),
      },
      ...(host.folder === undefined
        ? {}
        : hostIconSetsUnder(host.folder, persistence.dataDirectory)),
      saveUnder: (root) => (relativePath, bytes) =>
        saveGeneratedImageUnder({ root, relativePath, bytes }),
    }),
  );
  contribute("octant_credential", (host) =>
    childCredentialTools({
      host,
      service: deps.credentialRequests,
      operations: deps.credentialOperations,
      readParent: () => parentThread(host),
      windowCurrent: (windowId) =>
        deps.windowAuthorityStore.listWindowIds().some((id) => String(id) === String(windowId)),
    }),
  );
  contribute("octant_debug", (host) =>
    childDebugTools({ ...codeInput(host), debug: deps.debugService }),
  );
  contribute("octant_terminal", (host) => {
    const terminals = deps.codeOperationRuntime?.terminals;
    return terminals === undefined
      ? undefined
      : childTerminalTools({
          ...codeInput(host),
          terminals,
          launchFor: ({ thread, folder, executionPolicy }) => {
            const sandboxPolicy = activeSandboxPolicy(host.runId);
            return {
              shell: terminalShellFor({
                platform: process.platform,
                windowsShell: persistence.readCodeSettings()?.settings.windowsTerminalShell,
              }),
              cwd: folder,
              stateScope: String(thread.repositoryId),
              executionPolicy,
              ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
              // As a thread's own terminal: Windows has no sandbox to hold Strict to.
              ...(process.platform === "win32"
                ? { strict: deps.resolveThreadStrict(host.parentThreadId) }
                : {}),
            };
          },
        });
  });
  const ledger = new ChildBootedDeviceLedger(
    join(deps.providerDataDirectory, "child-devices", "booted.json"),
  );
  const deviceInput = (host: AgentRunChildToolHost): ChildDeviceToolInput => ({
    ...codeInput(host),
    ledger,
    describe: (effect, thread) => {
      const checkout = childCodeThreads.read(host)?.checkout;
      if (checkout === undefined) return "Allow a device action for a helper?";
      const { message, detail } = approvalPrompt(effect, thread, checkout, undefined);
      return `${message}\n${detail}`;
    },
    head: (threadId) => childCodeThreads.head(threadId),
  });
  const appleArtifacts = join(deps.providerDataDirectory, "apple-runtime", "artifacts");
  const androidArtifacts = join(deps.providerDataDirectory, "android-runtime", "artifacts");
  contribute("octant_apple", (host) =>
    childAppleTools({
      ...deviceInput(host),
      apple: deps.appleToolchainService,
      artifactRoot: appleArtifacts,
      recordEvidence: deps.recordAppleEvidence,
    }),
  );
  contribute("octant_android", (host) =>
    childAndroidTools({
      ...deviceInput(host),
      android: deps.androidToolchainService,
      artifactRoot: androidArtifacts,
    }),
  );
  return {
    settleChildDevices: async () => {
      for (const device of await ledger.leftOver()) {
        // A device not seen stopped stays on the list for the next start.
        const stopped =
          device.platform === "apple"
            ? await shutDownChildSimulator(deps.appleToolchainService, device, {
                artifactRoot: appleArtifacts,
                uuid: randomUUID,
              })
            : await shutDownChildEmulator(deps.androidToolchainService, device, {
                artifactRoot: androidArtifacts,
                uuid: randomUUID,
              });
        if (stopped) await ledger.remove(device);
      }
    },
  };
}
