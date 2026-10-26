import { createDesktopComputerUsePort } from "../computerUse/desktopComputerUsePort";
import { createComputerUseToolService } from "../computerUse/computerUseToolService";
import type { ComputerUseOwner } from "@octant/contracts/computer-use-plugin";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeChatThreadId, decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import { createMachineChangeRouteHandler } from "../machineChangeRoutes";
import { decodeBrowserThreadId } from "@octant/contracts/browser-automation";
import { createComputerUseRuntime } from "../computerUse/computerUseRuntime";
import { createNodeComputerUseProcessPort } from "../computerUse/nodeComputerUseProcessPort";
import { createComputerUseValidationEvidenceRecorder } from "../computerUse/computerUseValidationEvidence";
import { createComputerUseRouteHandler } from "../computerUseRoutes";
import { LaunchSessionStore } from "../launchSessionStore";
import { createLaunchSessionRouteHandler } from "../launchSessionRoutes";
import { createWebAssetsHandler } from "../webAssets";
import {
  readApprovalOutsideContent,
  readThreadExternalContentTaint,
} from "../context/externalContentTaintProjection";
import { readFile as readFileFromDisk, stat as statFromDisk } from "node:fs/promises";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { decodeDesktopHostTag, type DesktopHostTag } from "@octant/contracts";
import { defaultShellSettings } from "@octant/domain";
import { createDesktopLeaseService } from "../computerUse/desktopLeaseService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { withToolFamilyHelp } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import { COMPUTER_USE_TOOL_HELP } from "../plugins/computerUse/computerUsePlugin";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { UsageWiring } from "./usage";
import type { FoundationsWiring } from "./foundations";

export function resolveWebAssetsPath(): string {
  const fromEnv = process.env.OCTANT_WEB_DIST_PATH;
  if (fromEnv !== undefined && isAbsolute(fromEnv)) return fromEnv;
  const serverRoot = dirname(fileURLToPath(import.meta.url));
  return resolve(serverRoot, "..", "..", "web", "dist");
}

/**
 * This host's desktop tag: a random id minted once and kept beside the
 * journal. A data-directory path can repeat on two machines that share one
 * provider account, so the tag is never derived from it.
 */
function readOrMintDesktopHostTag(directory: string): DesktopHostTag {
  const path = join(directory, "host-tag");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Minted whole beside the tag and linked into place, which refuses to
  // replace an existing tag. Creating the tag file directly could leave it
  // empty after a crash, and an unreadable tag stops every later start.
  const minted = join(directory, `host-tag.${randomUUID()}.tmp`);
  writeFileSync(minted, randomUUID(), { flag: "wx", mode: 0o600 });
  try {
    linkSync(minted, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    rmSync(minted, { force: true });
  }
  return decodeDesktopHostTag(readFileSync(path, "utf8").trim());
}

/** How often lease clocks and failed releases are checked between journal commits. */
const DESKTOP_LEASE_SWEEP_INTERVAL_MS = 30_000;

export type ComputerUseDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<
    AuthorityWiring,
    "machineChangeFeed" | "onWindowRevoked" | "processAuthorityNow" | "windowAuthorityStore"
  > &
  Pick<AgentRunsWiring, "externalContentIngestionStore"> &
  Pick<UsageWiring, "validationEventStore"> &
  Pick<FoundationsWiring, "browserAuthority" | "providerRuntimeRegistry" | "workThreadProjection">;

export function wireComputerUse(deps: ComputerUseDependencies) {
  const {
    browserAuthority,
    externalContentIngestionStore,
    machineChangeFeed,
    onWindowRevoked,
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
            browserAuthority.resolve(decodeBrowserThreadId(owner.threadId), owner.mode),
          ownerIsCurrent: (owner) => {
            const current =
              owner.mode === "chat"
                ? persistence.readChatThread(decodeChatThreadId(owner.threadId))
                : owner.mode === "code"
                  ? persistence.readCodeThread(decodeCodeThreadId(owner.threadId))
                  : workThreadProjection.read(decodeWorkThreadId(owner.threadId));
            return (
              current?.lifecycle === "active" &&
              String(current.providerInstanceId) === String(owner.providerInstanceId) &&
              String(current.modelId) === String(owner.modelId) &&
              !(
                "executionPolicy" in current &&
                current.executionPolicy === "plan" &&
                owner.executionPolicy !== "plan"
              ) &&
              browserAuthority.canAccessWindow(
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
                : workThreadProjection.read(decodeWorkThreadId(owner.threadId))?.title) ??
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
  onWindowRevoked((windowId) => {
    void computerUseTools?.revokeWindow(windowId);
  });
  const computerToolsFor = (owner: ComputerUseOwner, selection: unknown) => {
    const model = providerRuntimeRegistry
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
  // No desktop provider is registered and no Project stores a recipe yet, so
  // every lease command refuses as a value; the service still reconciles and
  // sweeps so a lease journaled by any later build is torn down on start.
  // Callers bring their own authority when the Desktop pane and the agent's
  // lease binding arrive, so until then no caller may open a thread here.
  const desktopLeases = createDesktopLeaseService({
    journal: persistence.journal,
    projection: persistence.desktopLeaseProjection,
    hostTag: readOrMintDesktopHostTag(join(persistence.dataDirectory, "desktop-leases")),
    platform: process.platform,
    hasScreen: computerUseDesktop !== undefined || options.computerUseAdapter !== undefined,
    providers: () => [],
    recipe: () => undefined,
    thread: (owner) => {
      const current =
        owner.mode === "code"
          ? persistence.readCodeThread(decodeCodeThreadId(owner.threadId))
          : workThreadProjection.read(decodeWorkThreadId(owner.threadId));
      if (current === undefined) return undefined;
      return {
        active:
          current.lifecycle !== "archived" &&
          current.lifecycle !== "deleting" &&
          current.lifecycle !== "deleted" &&
          current.completedAt === undefined,
        executionPolicy:
          "executionPolicy" in current
            ? current.executionPolicy
            : current.access === "auto-accept-edits"
              ? "auto-accept-edits"
              : "approval-gated",
      };
    },
    callerMayOpen: () => false,
    computerUseEnabled: () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings()).computerUse.enabled,
    confirm: async () => "declined",
    systemActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    now: () => Date.now(),
    uuid: randomUUID,
  });
  void desktopLeases.start().catch(() => undefined);
  const sweepDesktopLeases = () => void desktopLeases.sweep().catch(() => undefined);
  const stopDesktopLeaseCommits = persistence.journal.subscribeCommitted(() =>
    queueMicrotask(sweepDesktopLeases),
  );
  const desktopLeaseTimer = setInterval(sweepDesktopLeases, DESKTOP_LEASE_SWEEP_INTERVAL_MS);
  desktopLeaseTimer.unref();
  const stopDesktopLeases = () => {
    stopDesktopLeaseCommits();
    clearInterval(desktopLeaseTimer);
  };
  const computerUseRuntime =
    options.computerUseRuntime ??
    computerUseTools?.runtime ??
    createComputerUseRuntime({
      ...(options.computerUseAdapter === undefined ? {} : { adapter: options.computerUseAdapter }),
      destination:
        options.computerUseAdapter === undefined
          ? desktopLeases.destination()
          : { status: "available", kind: "macos-host" },
      evidence: createComputerUseValidationEvidenceRecorder({
        eventStore: validationEventStore,
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      }),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
  onWindowRevoked((windowId) => {
    void computerUseRuntime.revokeWindow(windowId);
  });
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
    stopDesktopLeases,
    webAssets,
  };
}

export type ComputerUseWiring = ReturnType<typeof wireComputerUse>;
