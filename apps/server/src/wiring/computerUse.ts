import { createDesktopComputerUsePort } from "../computerUse/desktopComputerUsePort";
import {
  createComputerUseToolService,
  type ComputerUseThreadAsk,
} from "../computerUse/computerUseToolService";
import type { ComputerUseOwner } from "@octant/contracts/computer-use-plugin";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWindowId,
  decodeWorkThreadId,
} from "@octant/contracts";
import { createMachineChangeRouteHandler } from "../machineChangeRoutes";
import { decodeBrowserThreadId } from "@octant/contracts/browser-automation";
import { createComputerUseRuntime } from "../computerUse/computerUseRuntime";
import { createNodeComputerUseProcessPort } from "../computerUse/nodeComputerUseProcessPort";
import { createComputerUseValidationEvidenceRecorder } from "../computerUse/computerUseValidationEvidence";
import { createComputerUseRouteHandler } from "../computerUseRoutes";
import { createDesktopPaneRouteHandler } from "../desktopPaneRoutes";
import { LaunchSessionStore } from "../launchSessionStore";
import { createLaunchSessionRouteHandler } from "../launchSessionRoutes";
import { createWebAssetsHandler } from "../webAssets";
import {
  readApprovalOutsideContent,
  readThreadExternalContentTaint,
} from "../context/externalContentTaintProjection";
import { readFile as readFileFromDisk, stat as statFromDisk } from "node:fs/promises";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  decodeDesktopHostTag,
  type DesktopHostTag,
  type DesktopProviderId,
} from "@octant/contracts";
import { defaultShellSettings } from "@octant/domain";
import {
  createDesktopLeaseService,
  createLeasedComputerUsePort,
} from "../computerUse/desktopLeaseService";
import { createHostLocalDesktopLaunch } from "../computerUse/hostLocalDesktopLaunch";
import { createDesktopHttpsPort } from "../computerUse/desktopHttpsPort";
import {
  createHostLocalDesktopProvider,
  HOST_LOCAL_DESKTOP_PROGRAMS,
} from "../plugins/hostLocalDesktop/hostLocalDesktopProvider";
import {
  createE2bDesktopProvider,
  E2B_DESKTOP_HOSTS,
  E2B_DESKTOP_PROVIDER_ID,
} from "../plugins/e2bDesktop/e2bDesktopProvider";
import { makeDesktopProviderCredentialBrokerClient } from "../providers/credentialBrokerClient";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { withToolFamilyHelp } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import {
  COMPUTER_USE_TOOL_HELP,
  DISPOSABLE_DESKTOP_TOOL_HELP,
} from "../plugins/computerUse/computerUsePlugin";
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
  Pick<AgentRunsWiring, "externalContentIngestionStore" | "managedWorktreeReceipts"> &
  Pick<UsageWiring, "validationEventStore"> &
  Pick<FoundationsWiring, "browserAuthority" | "providerRuntimeRegistry" | "workThreadProjection">;

export function wireComputerUse(deps: ComputerUseDependencies) {
  const {
    browserAuthority,
    externalContentIngestionStore,
    machineChangeFeed,
    managedWorktreeReceipts,
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
  // No Project stores a recipe yet, so every lease command refuses as a
  // value; the service still reconciles and sweeps so a lease journaled by any
  // later build is torn down on start. An agent's turn bound to one of its
  // thread's leases operates it as that thread's agent and asks in its thread
  // through the Computer tool. A person reaches a Code thread's leases from
  // its Desktop tab, as the window or paired device that may open the thread.
  // A person acquiring a host-local desktop has already decided; a person's
  // billed lease starts only with the confirmation their own tab sends.
  //
  // On Linux the bundled host-local driver is always loaded, so teardown and
  // restart reconciliation can reap its desktops even after the programs it
  // needs were removed; it is offered for leasing only when its readiness
  // reported ready as the host started.
  const desktopLeaseDirectory = join(persistence.dataDirectory, "desktop-leases");
  const desktopHostTag = readOrMintDesktopHostTag(desktopLeaseDirectory);
  const hostLocalDesktopLaunch =
    process.platform === "linux"
      ? createHostLocalDesktopLaunch({
          directory: desktopLeaseDirectory,
          hostTag: desktopHostTag,
          platform: process.platform,
          provisioning: (leaseId) =>
            persistence.desktopLeaseProjection.get(leaseId)?.lease.state === "provisioning",
        })
      : undefined;
  const hostLocalDesktops =
    hostLocalDesktopLaunch === undefined
      ? []
      : [
          {
            provider: createHostLocalDesktopProvider(hostLocalDesktopLaunch),
            effective:
              hostLocalDesktopLaunch.readiness(HOST_LOCAL_DESKTOP_PROGRAMS).status === "ready",
          },
        ];
  // A cloud driver reaches its provider only through this port: its own
  // declared hosts, and the person's key from the desktop-provider namespace
  // of the credential broker, attached only for a credential reference one of
  // that provider's leases recorded. A host with no broker attaches no key.
  const desktopProviderCredentials =
    options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
      ? undefined
      : makeDesktopProviderCredentialBrokerClient({
          url: options.credentialBrokerUrl,
          token: options.credentialBrokerToken,
        });
  const cloudDesktopPort = (providerId: DesktopProviderId, hosts: ReadonlyArray<string>) =>
    createDesktopHttpsPort({
      hosts: () => hosts,
      credentialPermitted: (ref) =>
        persistence.desktopLeaseProjection
          .list()
          .some(
            (record) =>
              String(record.lease.providerId) === String(providerId) &&
              String(record.lease.credentialRef ?? "") === String(ref),
          ),
      credential: async (ref) => desktopProviderCredentials?.resolve(String(ref)),
    });
  // The bundled E2B driver is loaded on every host, so teardown and restart
  // reconciliation reach any E2B lease a host ever journaled. No host offers
  // it for leasing yet: a billed provider waits for the person's own opt-in,
  // which arrives with recipe storage and its key entry.
  const cloudDesktops = [
    {
      provider: createE2bDesktopProvider(
        cloudDesktopPort(E2B_DESKTOP_PROVIDER_ID, E2B_DESKTOP_HOSTS),
      ),
      effective: false,
    },
  ];
  const desktopProviders = [...hostLocalDesktops, ...cloudDesktops];
  const desktopLeases = createDesktopLeaseService({
    journal: persistence.journal,
    projection: persistence.desktopLeaseProjection,
    hostTag: desktopHostTag,
    platform: process.platform,
    hasScreen: computerUseDesktop !== undefined || options.computerUseAdapter !== undefined,
    providers: () => desktopProviders,
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
    // The lease service already refuses an agent naming another thread. The
    // agent must also be the thread's current provider: one the thread has
    // since switched away from no longer speaks for it. A person is the
    // window or paired device the request came from: a local window must be
    // live and hold the thread's Project, and a paired device reaches any
    // active Code Project's thread, as it does for every other Code read.
    // Only Code threads have a Desktop tab yet.
    callerMayOpen: (actor, owner, scopeId) => {
      if (actor.kind === "local-user" || actor.kind === "remote-device") {
        if (scopeId === undefined || owner.mode !== "code") return false;
        const thread = decodeBrowserThreadId(owner.threadId);
        if (actor.kind === "remote-device") {
          return (
            String(actor.deviceId) === scopeId &&
            browserAuthority.resolve(thread, "code") !== undefined
          );
        }
        return (
          windowAuthorityStore.listWindowIds().some((id) => String(id) === scopeId) &&
          browserAuthority.canAccessWindow(decodeWindowId(scopeId), thread, "code")
        );
      }
      if (actor.kind !== "agent") return false;
      const current =
        owner.mode === "code"
          ? persistence.readCodeThread(decodeCodeThreadId(owner.threadId))
          : workThreadProjection.read(decodeWorkThreadId(owner.threadId));
      return (
        current !== undefined &&
        String(current.providerInstanceId) === String(actor.providerInstanceId)
      );
    },
    computerUseEnabled: () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings()).computerUse.enabled,
    confirm: async () => "declined",
    // A thread bound to an older revision of its Project has no root, so a
    // transfer never reads from a folder the Project has since left.
    threadRoot: async (owner) => {
      if (owner.mode === "work") {
        const thread = workThreadProjection.read(decodeWorkThreadId(owner.threadId));
        const project =
          thread === undefined ? undefined : persistence.readProject(thread.projectId);
        if (thread === undefined || project?.type !== "work" || project.lifecycle !== "active") {
          return undefined;
        }
        const revision = project.bindingHistory.at(-1)?.revisionId;
        return thread.bindingRevisionId !== undefined &&
          String(thread.bindingRevisionId) === String(revision)
          ? project.binding.canonicalRoot
          : undefined;
      }
      const thread = persistence.readCodeThread(decodeCodeThreadId(owner.threadId));
      const project = thread === undefined ? undefined : persistence.readProject(thread.projectId);
      if (
        thread === undefined ||
        project?.type !== "code" ||
        project.lifecycle !== "active" ||
        String(thread.bindingRevisionId) !== String(project.bindingHistory.at(-1)?.revisionId)
      ) {
        return undefined;
      }
      const checkout = persistence.readCodeCheckout(thread.checkoutId);
      if (checkout === undefined || checkout.availability !== "available") return undefined;
      if (checkout.kind !== "managed-worktree") return project.binding.canonicalRoot;
      const receipt = await managedWorktreeReceipts.load(String(checkout.ownershipReceiptId));
      return receipt !== undefined &&
        receipt.state === "ready" &&
        String(receipt.threadId) === String(thread.id) &&
        String(receipt.checkoutId) === String(checkout.id) &&
        receipt.canonicalRepositoryPath === project.binding.canonicalRoot
        ? receipt.canonicalWorktreePath
        : undefined;
    },
    confirmTransfer: async () => "declined",
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
  // The tool service exists wherever a send can bind a destination: this
  // Mac's screen, or a desktop a Linux host can lease.
  const computerUseTools =
    computerUseDesktop === undefined && hostLocalDesktops.length === 0
      ? undefined
      : createComputerUseToolService({
          ...(computerUseDesktop === undefined ? {} : { desktop: computerUseDesktop }),
          ...(hostLocalDesktops.length === 0
            ? {}
            : {
                leases: createLeasedComputerUsePort(
                  desktopLeases,
                  persistence.desktopLeaseProjection,
                ),
              }),
          destination: () => desktopLeases.destination(),
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
  const computerToolsFor = (
    owner: ComputerUseOwner,
    selection: unknown,
    ask?: ComputerUseThreadAsk,
  ) => {
    const model = providerRuntimeRegistry
      .observedState(owner.providerInstanceId)
      ?.models.find((candidate) => String(candidate.id) === String(owner.modelId));
    const tools = computerUseTools?.toolSet(
      owner,
      selection,
      model?.inputModalities.includes("image") === true,
      ask,
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
          owner.leaseId === undefined ? COMPUTER_USE_TOOL_HELP : DISPOSABLE_DESKTOP_TOOL_HELP,
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
  const desktopPaneRoutes = createDesktopPaneRouteHandler({
    windowAuthorityStore,
    service: desktopLeases,
    localActorId: String(OCTANT_LOCAL_ACTOR_ID),
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
    desktopPaneRoutes,
    launchSessionRoutes,
    machineChangeRoutes,
    stopComputerSettingsWatch,
    stopDesktopLeases,
    webAssets,
  };
}

export type ComputerUseWiring = ReturnType<typeof wireComputerUse>;
