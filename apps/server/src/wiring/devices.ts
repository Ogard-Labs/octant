import {
  type AndroidEmulatorRequest,
  type AndroidRpcEnvelope,
  type AppleActionRequest,
  type AppleRpcEnvelope,
  type AppleSimulatorId,
  decodeCodeCheckoutId,
  decodeCodeRelativePath,
  decodeCodeThreadId,
  LOCAL_TOOL_HOST_ID,
  type WindowId,
} from "@octant/contracts";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import type { PersistenceService } from "../persistence/persistenceService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { ValidationEventStore } from "../validation/validationEventStore";
import { AppleRuntimeStore } from "../apple/appleRuntimeStore";
import {
  APPLE_TOOLCHAIN_HOST_READ_PATHS,
  type AppleExecutionContext,
  type AppleRuntimeReceipt,
  AppleToolchainService,
} from "../apple/appleToolchainService";
import { createDesktopSimulatorDevicePort } from "../apple/desktopSimulatorDevicePort";
import { simulatorInputThroughDesktop } from "../apple/simulatorInputThroughDesktop";
import { createSimulatorOrientationFollower } from "../apple/simulatorOrientationFollower";
import { createAppleToolchainRouteHandler } from "../appleToolchainRoutes";
import {
  type AndroidExecutionContext,
  AndroidToolchainService,
  androidToolchainStorePaths,
  isReplayedAndroidEvidence,
} from "../android/androidToolchainService";
import { AndroidRuntimeStore } from "../android/androidRuntimeStore";
import { spawnDetachedProcess } from "../android/spawnDetachedProcess";
import { serveAvdFromEnvironment } from "../android/serveAvdBrokerClient";
import { createAndroidToolchainRouteHandler } from "../androidToolchainRoutes";
import { composeAppleValidationEvents } from "../apple/appleValidationEvidence";
import {
  androidActionOpensInputGrant,
  appleActionOpensInputGrant,
  decidesCodeEffectsByApproval,
  isAndroidEmulatorInputKind,
  isAppleSimulatorInputKind,
} from "@octant/domain";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { WorkspaceWiring } from "./workspace";
import type { CodeWiring } from "./code";
import type { ProvidersWiring } from "./providers";

export function stableAppleRootId(rootPath: string): string {
  const digest = createHash("sha256")
    .update("octant.apple-root.v1\0")
    .update(rootPath)
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function appleRestartContext(
  receipt: AppleRuntimeReceipt,
  persistence: PersistenceService,
  artifactRoot: string,
): AppleExecutionContext | undefined {
  const thread = persistence.readCodeThread(decodeCodeThreadId(receipt.threadId));
  const checkout = persistence.readCodeCheckout(decodeCodeCheckoutId(receipt.checkoutId));
  const project = thread === undefined ? undefined : persistence.readProject(thread.projectId);
  if (
    thread === undefined ||
    checkout === undefined ||
    project === undefined ||
    project.type !== "code" ||
    project.lifecycle !== "active" ||
    thread.lifecycle !== "active" ||
    thread.checkoutId !== checkout.id ||
    thread.repositoryId !== checkout.repositoryId ||
    checkout.head.kind === "none" ||
    receipt.authority.hostId !== LOCAL_TOOL_HOST_ID ||
    receipt.authority.mode !== "code" ||
    receipt.authority.projectId !== thread.projectId ||
    receipt.authority.providerInstanceId !== thread.providerInstanceId ||
    receipt.authority.extension.kind !== "core" ||
    (receipt.authority.worktreeId !== undefined &&
      String(receipt.authority.worktreeId) !== String(checkout.id)) ||
    (receipt.authority.rootId !== undefined &&
      String(receipt.authority.rootId) !== stableAppleRootId(project.binding.canonicalRoot))
  ) {
    return undefined;
  }
  return {
    authority: receipt.authority,
    threadId: thread.id,
    checkoutId: checkout.id,
    checkoutRoot: project.binding.canonicalRoot,
    artifactRoot,
    sourceRevision: checkout.head.oid,
    executionPolicy: thread.executionPolicy,
    approvalValid: false,
  };
}

/**
 * The Code runtime's check of a device action's one-use approval. Undefined
 * when the host has no runtime, which refuses the approval.
 */
export interface DeviceApprovalChecks {
  readonly validateAppleApproval: (
    windowId: WindowId,
    request: AppleActionRequest,
  ) => Promise<boolean> | undefined;
  readonly validateAndroidApproval: (
    windowId: WindowId,
    request: AndroidEmulatorRequest,
  ) => Promise<boolean> | undefined;
}

export type DevicesDependencies = Pick<ServerStart, "persistence"> &
  Pick<
    AuthorityWiring,
    "androidInputGrants" | "codeSessionAuthority" | "simulatorInputGrants" | "windowAuthorityStore"
  > &
  Pick<WorkspaceWiring, "projectService"> &
  Pick<CodeWiring, "roots"> &
  Pick<ProvidersWiring, "providerDataDirectory">;

export function wireDevices(deps: DevicesDependencies) {
  const {
    androidInputGrants,
    codeSessionAuthority,
    persistence,
    projectService,
    providerDataDirectory,
    roots,
    simulatorInputGrants,
    windowAuthorityStore,
  } = deps;
  return Effect.gen(function* () {
    const appleRuntimeStore = new AppleRuntimeStore(join(providerDataDirectory, "apple-runtime"));
    const appleProcess = new RepositoryTestProcessPort({
      receiptDirectory: join(providerDataDirectory, "apple-runtime", "test-receipts"),
      literalReadPaths: APPLE_TOOLCHAIN_HOST_READ_PATHS,
      allowSimulatorControl: true,
    });
    yield* Effect.promise(() => appleProcess.reconcile());
    // Present only under the desktop app, which owns the native device helper.
    const simulatorDevice = createDesktopSimulatorDevicePort(process.env);
    // Raw captures land under this host's own data directory, created 0700 —
    // a root no other confined launch is granted, so device pixels are never
    // readable by an unrelated confined command. Only the capture
    // launch itself carries the directory as an extra write root.
    const appleCaptureDirectory = join(providerDataDirectory, "apple-runtime", "captures");
    // Folders the removed physical-device and distribution features left in this
    // data directory. They may still hold device listings, entitlements, or a
    // key file, so every Apple launch stays denied them.
    const leftoverPrivateDirectories = [
      "devicectl",
      "device-captures",
      "signing",
      "distribution-keys",
    ].map((name) => join(providerDataDirectory, "apple-runtime", name));
    const appleToolchainService = new AppleToolchainService({
      execute: (input, signal) => appleProcess.execute(input, signal),
      ...(simulatorDevice === undefined
        ? {}
        : { injectSimulatorInput: simulatorInputThroughDesktop(simulatorDevice) }),
      observeSimulators: (simulators) => simulatorInputGrants.closeUnlessBooted(simulators),
      captureDirectory: appleCaptureDirectory,
      isolatedRoots: leftoverPrivateDirectories,
      // A host sweeps only the captures named for its own data directory, so
      // two hosts pointed at one directory never clear each other's files.
      captureOwner: createHash("sha256").update(providerDataDirectory).digest("hex").slice(0, 16),
      realpath,
      writeArtifact: (reference, bytes) => appleRuntimeStore.writeArtifact(reference, bytes),
      readArtifact: (reference) => appleRuntimeStore.readArtifact(reference),
      persistReceipts: (receipts) => appleRuntimeStore.persistReceipts(receipts),
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    // The Simulator's real orientation follows its foreground app, so it is
    // re-read after input that can change the app and, slowly, while watched.
    const simulatorOrientation =
      simulatorDevice === undefined
        ? undefined
        : createSimulatorOrientationFollower({
            read: async (simulatorId, signal) => {
              const answer = await simulatorDevice.deliver(
                { kind: "read-orientation", udid: simulatorId, budgetMs: 5_000 },
                signal,
              );
              return answer.kind === "delivered" ? answer.orientation : undefined;
            },
            note: (simulatorId, orientation) =>
              appleToolchainService.noteOrientation(simulatorId as AppleSimulatorId, orientation),
          });
    const appleValidationEvents = new ValidationEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const recordAppleEvidence = (
      evidence: import("@octant/contracts").AppleBuildEvidence,
      startedAt: string,
    ) => {
      const composed = composeAppleValidationEvents({ evidence, startedAt, newId: randomUUID });
      appleValidationEvents.appendPlan({ plan: composed.plan, expectedVersion: 0 });
      appleValidationEvents.appendEvidence({ evidence: composed.record, expectedVersion: 1 });
      appleValidationEvents.appendReport({ report: composed.report, expectedVersion: 2 });
    };
    const androidRuntimeStore = new AndroidRuntimeStore(
      join(providerDataDirectory, "android-runtime"),
    );
    const androidProcess = new RepositoryTestProcessPort({
      receiptDirectory: join(providerDataDirectory, "android-runtime", "test-receipts"),
      additionalWritePaths: androidToolchainStorePaths(process.env),
      allowSimulatorControl: true,
    });
    yield* Effect.promise(() => androidProcess.reconcile());
    const serveAvd = serveAvdFromEnvironment(process.env);
    const androidToolchainService = new AndroidToolchainService({
      execute: (input, signal) => androidProcess.execute(input, signal),
      spawnDetached: spawnDetachedProcess,
      ...(serveAvd === undefined ? {} : { serveAvd }),
      observeEmulators: (emulators) =>
        androidInputGrants.closeUnlessBooted(
          emulators.map((emulator) => ({
            simulatorId: emulator.emulatorId,
            state: emulator.state,
          })),
        ),
      realpath,
      writeArtifact: (reference, bytes, scope) =>
        androidRuntimeStore.writeArtifact(reference, bytes, scope),
      readArtifact: (reference, scope) => androidRuntimeStore.readArtifact(reference, scope),
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    // A device action the person allowed carries a one-use approval only the
    // Code runtime can check, and the runtime runs device actions through these
    // same resolvers, so the runtime's area calls this with its own check.
    const bindDeviceApprovals = (approvals: DeviceApprovalChecks) => {
      const appleRootProbe = decodeCodeRelativePath("package.json");
      // The thread, checkout, and root an Apple request may act in, the same
      // for the Simulator.
      const resolveAppleThread = async (
        windowId: WindowId,
        scope: {
          readonly authority: import("@octant/contracts").ToolActionAuthority;
          readonly threadId: import("@octant/contracts").CodeThreadId;
          readonly checkoutId: import("@octant/contracts").CodeCheckoutId;
        },
      ) => {
        const thread = persistence.readCodeThread(scope.threadId);
        const checkout = persistence.readCodeCheckout(scope.checkoutId);
        if (
          thread === undefined ||
          checkout === undefined ||
          thread.checkoutId !== checkout.id ||
          thread.repositoryId !== checkout.repositoryId ||
          thread.lifecycle !== "active" ||
          checkout.availability !== "available" ||
          // Apple evidence is pinned to a source revision; a plain folder has none.
          checkout.head.kind === "none" ||
          scope.authority.hostId !== LOCAL_TOOL_HOST_ID ||
          scope.authority.mode !== "code" ||
          scope.authority.projectId !== thread.projectId ||
          scope.authority.providerInstanceId !== thread.providerInstanceId ||
          scope.authority.extension.kind !== "core"
        ) {
          return undefined;
        }
        const projects = await projectService.bootstrap(windowId);
        if (
          !projects.active.some(
            (project) => project.id === thread.projectId && project.type === "code",
          )
        ) {
          return undefined;
        }
        const resolvedRoot = await roots.resolve(windowId, thread, checkout, appleRootProbe);
        if (resolvedRoot === undefined) return undefined;
        if (
          scope.authority.worktreeId !== undefined &&
          String(scope.authority.worktreeId) !== String(checkout.id)
        ) {
          return undefined;
        }
        if (
          scope.authority.rootId !== undefined &&
          String(scope.authority.rootId) !== stableAppleRootId(resolvedRoot.rootPath)
        ) {
          return undefined;
        }
        return {
          thread,
          checkout,
          rootPath: resolvedRoot.rootPath,
          sourceRevision: checkout.head.oid,
        };
      };
      const resolveAppleContext = async (
        windowId: WindowId,
        scope: {
          readonly authority: import("@octant/contracts").ToolActionAuthority;
          readonly threadId: import("@octant/contracts").CodeThreadId;
          readonly checkoutId: import("@octant/contracts").CodeCheckoutId;
        },
        envelope: AppleRpcEnvelope,
      ): Promise<AppleExecutionContext | undefined> => {
        const resolved = await resolveAppleThread(windowId, scope);
        if (resolved === undefined) return undefined;
        const { thread, checkout } = resolved;
        const effectiveThread = codeSessionAuthority.effectiveThread(windowId, thread);
        const action = envelope.kind === "apple-action-request" ? envelope.request : undefined;
        const inputSimulatorId =
          action !== undefined && isAppleSimulatorInputKind(action.kind) && "simulatorId" in action
            ? action.simulatorId
            : undefined;
        const grantDestinationId =
          action !== undefined && appleActionOpensInputGrant(action.kind) && "simulatorId" in action
            ? action.simulatorId
            : undefined;
        let approvalValid: boolean;
        let inputGranted = false;
        if (action === undefined || effectiveThread.executionPolicy === "full-access") {
          approvalValid = true;
        } else if (!decidesCodeEffectsByApproval(effectiveThread.executionPolicy)) {
          approvalValid = false;
        } else if (
          inputSimulatorId !== undefined &&
          simulatorInputGrants.isOpen({
            windowId: String(windowId),
            threadId: String(thread.id),
            simulatorId: String(inputSimulatorId),
          })
        ) {
          // One Allow input opened this Simulator to this window on this thread;
          // clicks then ride the grant. The grant is the window's, like the
          // approval it came from, so another client on the thread does not ride
          // it. Allow input itself never skips its confirmation this way.
          approvalValid = true;
          inputGranted = true;
        } else {
          approvalValid = (await approvals.validateAppleApproval(windowId, action)) ?? false;
          if (approvalValid && grantDestinationId !== undefined) {
            simulatorInputGrants.open({
              windowId: String(windowId),
              threadId: String(thread.id),
              simulatorId: String(grantDestinationId),
            });
          }
        }
        return {
          authority: scope.authority,
          threadId: thread.id,
          checkoutId: checkout.id,
          checkoutRoot: resolved.rootPath,
          artifactRoot: appleRuntimeStore.artifactRoot,
          sourceRevision: resolved.sourceRevision,
          executionPolicy: effectiveThread.executionPolicy,
          approvalValid,
          ...(inputGranted ? { inputGranted } : {}),
        };
      };
      const appleToolchainRoutes = createAppleToolchainRouteHandler({
        windowAuthorityStore,
        service: appleToolchainService,
        resolveContext: resolveAppleContext,
        afterAction: (windowId, request, evidence, context) => {
          simulatorInputGrants.settle(String(windowId), request, evidence, context);
          if ("simulatorId" in request && request.simulatorId !== undefined) {
            simulatorOrientation?.afterInput(
              String(request.simulatorId),
              request,
              evidence.outcome,
            );
          }
        },
        inputGrants: (windowId, threadId) =>
          simulatorInputGrants.list(String(windowId), String(threadId)),
        ...(simulatorDevice === undefined
          ? {}
          : {
              // A pane is a few hundred points tall; 30 frames a second of a
              // screen scaled to 1100 pixels is sharp there and about 1 MB/s.
              watchSimulator: async (simulatorId: string, signal: AbortSignal) => {
                const watch = await simulatorDevice.watch(
                  { udid: simulatorId, maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 },
                  signal,
                );
                if (watch.kind === "watching" && watch.orientation !== undefined) {
                  appleToolchainService.noteOrientation(
                    simulatorId as AppleSimulatorId,
                    watch.orientation,
                  );
                }
                if (watch.kind === "watching")
                  simulatorOrientation?.whileWatching(simulatorId, signal);
                return watch;
              },
            }),
        recordEvidence: recordAppleEvidence,
        maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      });
      const androidRootProbe = decodeCodeRelativePath("package.json");
      const resolveAndroidContext = async (
        windowId: WindowId,
        scope: {
          readonly authority: import("@octant/contracts").ToolActionAuthority;
          readonly threadId: import("@octant/contracts").CodeThreadId;
          readonly checkoutId: import("@octant/contracts").CodeCheckoutId;
        },
        envelope: AndroidRpcEnvelope,
      ): Promise<AndroidExecutionContext | undefined> => {
        const thread = persistence.readCodeThread(scope.threadId);
        const checkout = persistence.readCodeCheckout(scope.checkoutId);
        if (
          thread === undefined ||
          checkout === undefined ||
          thread.checkoutId !== checkout.id ||
          thread.repositoryId !== checkout.repositoryId ||
          thread.lifecycle !== "active" ||
          checkout.availability !== "available" ||
          scope.authority.hostId !== LOCAL_TOOL_HOST_ID ||
          scope.authority.mode !== "code" ||
          scope.authority.projectId !== thread.projectId ||
          scope.authority.providerInstanceId !== thread.providerInstanceId ||
          scope.authority.extension.kind !== "core"
        ) {
          return undefined;
        }
        const projects = await projectService.bootstrap(windowId);
        if (
          !projects.active.some(
            (project) => project.id === thread.projectId && project.type === "code",
          )
        ) {
          return undefined;
        }
        const resolvedRoot = await roots.resolve(windowId, thread, checkout, androidRootProbe);
        if (resolvedRoot === undefined) return undefined;
        if (
          scope.authority.worktreeId !== undefined &&
          String(scope.authority.worktreeId) !== String(checkout.id)
        ) {
          return undefined;
        }
        const effectiveThread = codeSessionAuthority.effectiveThread(windowId, thread);
        const action = envelope.kind === "android-action-request" ? envelope.request : undefined;
        const inputEmulatorId =
          action !== undefined && isAndroidEmulatorInputKind(action.kind)
            ? action.emulatorId
            : undefined;
        const grantDestinationId =
          action !== undefined && androidActionOpensInputGrant(action.kind)
            ? action.emulatorId
            : undefined;
        let approvalValid: boolean;
        let inputGranted = false;
        if (action === undefined || effectiveThread.executionPolicy === "full-access") {
          approvalValid = true;
        } else if (!decidesCodeEffectsByApproval(effectiveThread.executionPolicy)) {
          approvalValid = false;
        } else if (
          inputEmulatorId !== undefined &&
          androidInputGrants.isOpen({
            windowId: String(windowId),
            threadId: String(thread.id),
            simulatorId: String(inputEmulatorId),
          })
        ) {
          approvalValid = true;
          inputGranted = true;
        } else {
          approvalValid = (await approvals.validateAndroidApproval(windowId, action)) ?? false;
          if (approvalValid && grantDestinationId !== undefined) {
            androidInputGrants.open({
              windowId: String(windowId),
              threadId: String(thread.id),
              simulatorId: String(grantDestinationId),
            });
          }
        }
        return {
          authority: scope.authority,
          threadId: thread.id,
          checkoutId: checkout.id,
          checkoutRoot: resolvedRoot.rootPath,
          artifactRoot: androidRuntimeStore.artifactRoot,
          executionPolicy: effectiveThread.executionPolicy,
          approvalValid,
          ...(inputGranted ? { inputGranted } : {}),
        };
      };
      const androidToolchainRoutes = createAndroidToolchainRouteHandler({
        windowAuthorityStore,
        service: androidToolchainService,
        resolveContext: resolveAndroidContext,
        afterAction: (windowId, request, evidence, context) => {
          if (isReplayedAndroidEvidence(evidence)) return;
          androidInputGrants.settle(
            String(windowId),
            { kind: request.kind, simulatorId: request.emulatorId },
            evidence,
            context,
          );
        },
        inputGrants: (windowId, threadId) =>
          androidInputGrants.list(String(windowId), String(threadId)).map((grant) => ({
            emulatorId: grant.simulatorId,
            expiresAt: grant.expiresAt,
          })),
        maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      });
      return {
        androidToolchainRoutes,
        appleToolchainRoutes,
        resolveAndroidContext,
        resolveAppleContext,
      };
    };
    yield* Effect.promise(async () => {
      const receipts = await appleRuntimeStore.loadReceipts();
      for (const receipt of receipts) {
        const context = appleRestartContext(receipt, persistence, appleRuntimeStore.artifactRoot);
        if (context !== undefined) {
          const reconciled = await appleToolchainService.reconcileAfterRestart([receipt], context);
          for (const evidence of reconciled) recordAppleEvidence(evidence, receipt.startedAt);
        }
      }
      await appleRuntimeStore.persistReceipts([]);
    });
    return {
      androidToolchainService,
      appleToolchainService,
      bindDeviceApprovals,
      recordAppleEvidence,
    };
  });
}

export type DevicesWiring = Effect.Effect.Success<ReturnType<typeof wireDevices>>;
