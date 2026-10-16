import { createDesktopComputerUsePort } from "../computerUse/desktopComputerUsePort";
import { createComputerUseToolService } from "../computerUse/computerUseToolService";
import type { ComputerUseOwner } from "@octant/contracts/computer-use-plugin";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeChatThreadId, decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import { createMachineChangeRouteHandler } from "../machineChangeRoutes";
import { decodeBrowserThreadId } from "@octant/contracts/browser-automation";
import { WorkThreadProjection } from "../work/workThreadProjection";
import { createComputerUseRuntime } from "../computerUse/computerUseRuntime";
import { createNodeComputerUseProcessPort } from "../computerUse/nodeComputerUseProcessPort";
import { createComputerUseValidationEvidenceRecorder } from "../computerUse/computerUseValidationEvidence";
import { createComputerUseRouteHandler } from "../computerUseRoutes";
import { LaunchSessionStore } from "../launchSessionStore";
import { createLaunchSessionRouteHandler } from "../launchSessionRoutes";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { createWebAssetsHandler } from "../webAssets";
import {
  readApprovalOutsideContent,
  readThreadExternalContentTaint,
} from "../context/externalContentTaintProjection";
import { ServerBrowserAuthorityResolver } from "../browser/browserAuthorityResolver";
import { readFile as readFileFromDisk, stat as statFromDisk } from "node:fs/promises";
import { defaultShellSettings } from "@octant/domain";
import { withToolFamilyHelp } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import { COMPUTER_USE_TOOL_HELP } from "../plugins/computerUse/computerUsePlugin";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { LateBindings } from "./lateBindings";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { UsageWiring } from "./usage";

export function resolveWebAssetsPath(): string {
  const fromEnv = process.env.OCTANT_WEB_DIST_PATH;
  if (fromEnv !== undefined && isAbsolute(fromEnv)) return fromEnv;
  const serverRoot = dirname(fileURLToPath(import.meta.url));
  return resolve(serverRoot, "..", "..", "web", "dist");
}

export type ComputerUseDependencies = Pick<ServerStart, "options" | "persistence"> & {
  /** Cells settled by a later wiring call; read per use, never at construction. */
  readonly late: Pick<LateBindings, "activeComputerUseRuntime" | "activeComputerUseTools">;
} & Pick<AuthorityWiring, "machineChangeFeed" | "processAuthorityNow" | "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "externalContentIngestionStore"> &
  Pick<UsageWiring, "validationEventStore"> & {
    /** Wired by wireBrowser; read only after startup. */
    readonly browserAuthority: () => ServerBrowserAuthorityResolver;
    /** Wired by wireProviders; read only after startup. */
    readonly providerRuntimeRegistry: () => ProviderRuntimeRegistry;
    /** Wired by wireWorkspace; read only after startup. */
    readonly workThreadProjection: () => WorkThreadProjection;
  };

export function wireComputerUse(deps: ComputerUseDependencies) {
  const {
    late,
    browserAuthority,
    externalContentIngestionStore,
    machineChangeFeed,
    options,
    persistence,
    processAuthorityNow,
    providerRuntimeRegistry,
    validationEventStore,
    windowAuthorityStore,
    workThreadProjection,
  } = deps;

  const computerUseProcess = createNodeComputerUseProcessPort({
    receiptDirectory: join(persistence.dataDirectory, "computer-use", "runtime-receipts"),
  });
  const computerUseDesktop =
    options.computerUseDesktop ?? createDesktopComputerUsePort(process.env);
  const computerUseTools =
    computerUseDesktop === undefined
      ? undefined
      : createComputerUseToolService({
          desktop: computerUseDesktop,
          settings: () =>
            (persistence.readShellSettings()?.settings ?? defaultShellSettings()).computerUse,
          authority: (owner) =>
            browserAuthority().resolve(decodeBrowserThreadId(owner.threadId), owner.mode),
          ownerIsCurrent: (owner) => {
            const current =
              owner.mode === "chat"
                ? persistence.readChatThread(decodeChatThreadId(owner.threadId))
                : owner.mode === "code"
                  ? persistence.readCodeThread(decodeCodeThreadId(owner.threadId))
                  : workThreadProjection().read(decodeWorkThreadId(owner.threadId));
            return (
              current?.lifecycle === "active" &&
              String(current.providerInstanceId) === String(owner.providerInstanceId) &&
              String(current.modelId) === String(owner.modelId) &&
              !(
                "executionPolicy" in current &&
                current.executionPolicy === "plan" &&
                owner.executionPolicy !== "plan"
              ) &&
              browserAuthority().canAccessWindow(
                owner.windowId,
                decodeBrowserThreadId(owner.threadId),
                owner.mode,
              )
            );
          },
          toolConstraints: (owner) =>
            owner.mode === "code"
              ? (persistence.readCodeThread(decodeCodeThreadId(owner.threadId))?.toolConstraints ??
                [])
              : [],
          externalContentIngested: (owner) =>
            readThreadExternalContentTaint(persistence.connection, owner.threadId)
              .externalContentIngested,
          outsideContent: (owner) =>
            readApprovalOutsideContent(persistence.connection, owner.threadId),
          threadTitle: (owner) =>
            (owner.mode === "chat"
              ? persistence.readChatThread(decodeChatThreadId(owner.threadId))?.title
              : owner.mode === "code"
                ? persistence.readCodeThread(decodeCodeThreadId(owner.threadId))?.title
                : workThreadProjection().read(decodeWorkThreadId(owner.threadId))?.title) ??
            "this task",
          record: (() => {
            const recorder = createComputerUseValidationEvidenceRecorder({
              eventStore: validationEventStore,
              uuid: randomUUID,
              clock: () => new Date().toISOString(),
            });
            return async (event) => {
              await recorder.record(event);
              machineChangeFeed.publish(["computer-use"]);
            };
          })(),
        });
  const activeComputerUseTools = computerUseTools;
  late.activeComputerUseTools.current = activeComputerUseTools;
  const computerToolsFor = (owner: ComputerUseOwner, selection: unknown) => {
    const model = providerRuntimeRegistry()
      .observedState(owner.providerInstanceId)
      ?.models.find((candidate) => String(candidate.id) === String(owner.modelId));
    const tools = computerUseTools?.toolSet(
      owner,
      selection,
      model?.inputModalities.includes("image") === true,
    );
    // Help is the plugin's own static guidance, not application content, so
    // it is answered outside the taint wrapper and never marks the thread.
    return tools === undefined
      ? undefined
      : withToolFamilyHelp(
          taintAppManagedToolResults({
            tools,
            threadId: owner.threadId,
            recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
            uuid: randomUUID,
          }),
          COMPUTER_USE_TOOL_HELP,
        );
  };
  let lastComputerSettings = "";
  let computerSettingsTail = Promise.resolve();
  const syncComputerUseSettings = () => {
    const settings = (persistence.readShellSettings()?.settings ?? defaultShellSettings())
      .computerUse;
    const encoded = JSON.stringify(settings);
    if (encoded !== lastComputerSettings) {
      lastComputerSettings = encoded;
      computerSettingsTail = computerSettingsTail
        .then(async () => {
          await computerUseDesktop?.configure(settings);
        })
        .catch(() => undefined);
    }
    void computerUseTools?.sweep().catch(() => undefined);
  };
  const stopComputerSettingsWatch = persistence.journal.subscribeCommitted(() =>
    queueMicrotask(syncComputerUseSettings),
  );
  syncComputerUseSettings();
  const computerUseRuntime =
    options.computerUseRuntime ??
    computerUseTools?.runtime ??
    createComputerUseRuntime({
      ...(options.computerUseAdapter === undefined ? {} : { adapter: options.computerUseAdapter }),
      destination:
        options.computerUseAdapter === undefined
          ? { status: "unavailable", kind: "no-destination" }
          : { status: "available", kind: "macos-host" },
      evidence: createComputerUseValidationEvidenceRecorder({
        eventStore: validationEventStore,
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      }),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
  const activeComputerUseRuntime = computerUseRuntime;
  late.activeComputerUseRuntime.current = activeComputerUseRuntime;
  const computerUseRoutes = createComputerUseRouteHandler({
    runtime: computerUseRuntime,
    windowAuthorityStore,
    maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  const launchSessionStore = new LaunchSessionStore({
    clampNow: processAuthorityNow,
  });
  const launchSessionRoutes = createLaunchSessionRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    ...(options.allowedRendererHttpOrigin === undefined
      ? {}
      : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
    launchSessionStore,
    windowAuthorityStore,
  });
  const machineChangeRoutes = createMachineChangeRouteHandler({
    feed: machineChangeFeed,
    windowAuthorityStore,
  });
  const webAssetsPath = options.webAssetsPath ?? resolveWebAssetsPath();
  const webAssets = createWebAssetsHandler({
    distPath: webAssetsPath,
    readFile: async (path) => readFileFromDisk(path),
    stat: async (path) => statFromDisk(path),
  });
  return {
    computerToolsFor,
    computerUseProcess,
    computerUseRoutes,
    computerUseRuntime,
    computerUseTools,
    launchSessionRoutes,
    machineChangeRoutes,
    stopComputerSettingsWatch,
    webAssets,
  };
}

export type ComputerUseWiring = ReturnType<typeof wireComputerUse>;
