import {
  type AndroidEmulatorRequest,
  type AndroidRpcEnvelope,
  type AppleActionRequest,
  type AppleDeviceRequest,
  type AppleRpcEnvelope,
  type AppleSimulatorId,
  type CodeThread,
  decodeCodeCheckoutId,
  decodeCodeRelativePath,
  decodeCodeThreadId,
  LOCAL_TOOL_HOST_ID,
  THREAD_RETENTION_EVENT_NAMES,
  type WindowId,
} from "@octant/contracts";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import type { PersistenceService } from "../persistence/persistenceService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { ValidationEventStore } from "../validation/validationEventStore";
import { AppleRuntimeStore } from "../apple/appleRuntimeStore";
import { AppleDeviceService, type AppleDeviceExecutionContext } from "../apple/appleDeviceService";
import { createAppleDeviceRouteHandler } from "../appleDeviceRoutes";
import type { ClientPrincipal } from "../clientPrincipal";
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
  /** Whether a person at this window confirmed exactly this device lease. */
  readonly validateAppleDeviceLease: (
    windowId: WindowId,
    request: AppleDeviceRequest,
  ) => Promise<boolean> | undefined;
  /** Whether this window holds the one-use approval of exactly this device effect. */
  readonly validateAppleDeviceAction: (
    windowId: WindowId,
    request: AppleDeviceRequest,
  ) => Promise<boolean> | undefined;
}

// Device effects a thread's posture decides, one approval per request.
const APPLE_DEVICE_EFFECT_KINDS: ReadonlySet<AppleDeviceRequest["kind"]> = new Set([
  "build",
  "run",
  "install",
  "launch",
  "terminate",
]);

/**
 * The context a physical device request acts under, for a pane click through
 * the device route and for the thread's agent through `octant_apple`.
 *
 * A lease start counts only when a person at a local window answered its
 * confirmation: the host's confirmations are shown by the desktop app, never
 * to a paired device. A device effect follows the thread's posture like a
 * Simulator effect: Full access runs it, approval-gated postures need this
 * window's one-use approval of exactly this request, and Plan is refused by
 * the device policy.
 *
 * The agent's requests come from no window principal, so a receipt counts
 * only because the Code runtime mints one for a device lease or effect after
 * a person at a window on this Mac answered it in the thread; a paired
 * device's answer mints nothing.
 */
export function createAppleDeviceScopes(deps: {
  readonly resolveThread: (
    windowId: WindowId,
    request: AppleDeviceRequest,
  ) => Promise<
    | {
        readonly thread: CodeThread;
        readonly checkout: { readonly id: CodeThread["checkoutId"] };
        readonly rootPath: string;
      }
    | undefined
  >;
  readonly effectiveThread: (windowId: WindowId, thread: CodeThread) => CodeThread;
  readonly approvals: Pick<
    DeviceApprovalChecks,
    "validateAppleDeviceLease" | "validateAppleDeviceAction"
  >;
}) {
  const { approvals } = deps;
  const resolveAppleDeviceContext = async (
    windowId: WindowId,
    request: AppleDeviceRequest,
    mayCarryReceipt: boolean,
  ): Promise<AppleDeviceExecutionContext | undefined> => {
    const resolved = await deps.resolveThread(windowId, request);
    if (resolved === undefined) return undefined;
    const effectiveThread = deps.effectiveThread(windowId, resolved.thread);
    const confirmed =
      request.kind === "use-device" &&
      request.approval.kind === "approved" &&
      mayCarryReceipt &&
      ((await approvals.validateAppleDeviceLease(windowId, request)) ?? false);
    const effectApproved =
      APPLE_DEVICE_EFFECT_KINDS.has(request.kind) &&
      mayCarryReceipt &&
      (effectiveThread.executionPolicy === "full-access" ||
        (decidesCodeEffectsByApproval(effectiveThread.executionPolicy) &&
          request.approval.kind === "approved" &&
          ((await approvals.validateAppleDeviceAction(windowId, request)) ?? false)));
    return {
      authority: request.authority,
      threadId: resolved.thread.id,
      checkoutId: resolved.checkout.id,
      checkoutRoot: resolved.rootPath,
      executionPolicy: effectiveThread.executionPolicy,
      approvalValid: confirmed || effectApproved,
      ...(confirmed
        ? { approvedBy: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID } as const }
        : {}),
    };
  };
  return {
    resolveAppleDeviceScope: (
      windowId: WindowId,
      request: AppleDeviceRequest,
      principal: ClientPrincipal,
    ) => resolveAppleDeviceContext(windowId, request, principal.kind === "local-window"),
    // The agent speaks only for itself: a request naming a person is a pane
    // click, which comes through the route and its principal check.
    resolveAppleDeviceAgentScope: async (windowId: WindowId, request: AppleDeviceRequest) =>
      request.requestedBy.kind === "agent"
        ? await resolveAppleDeviceContext(windowId, request, true)
        : undefined,
  };
}

export type DevicesDependencies = Pick<ServerStart, "persistence"> &
  Pick<
    AuthorityWiring,
    | "androidInputGrants"
    | "appleDeviceLeases"
    | "codeSessionAuthority"
    | "simulatorInputGrants"
    | "windowAuthorityStore"
  > &
  Pick<WorkspaceWiring, "projectService"> &
  Pick<CodeWiring, "roots"> &
  Pick<ProvidersWiring, "providerDataDirectory">;

export function wireDevices(deps: DevicesDependencies) {
  const {
    androidInputGrants,
    appleDeviceLeases,
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
    // readable by an unrelated confined command (0160). Only the capture
    // launch itself carries the directory as an extra write root.
    const appleCaptureDirectory = join(providerDataDirectory, "apple-runtime", "captures");
    // `devicectl` writes its answers here, and a device listing names every
    // paired device's hardware identifiers, so it is private the same way.
    const devicectlOutputDirectory = join(providerDataDirectory, "apple-runtime", "devicectl");
    // A physical device's screen lands here before it becomes evidence; only
    // its own capture launch may write it, as with the Simulator's captures.
    const deviceCaptureDirectory = join(providerDataDirectory, "apple-runtime", "device-captures");
    // The entitlements a device signature reads. Private like the others: no
    // build, Simulator, or `devicectl` launch reaches it.
    const appleSigningDirectory = join(providerDataDirectory, "apple-runtime", "signing");
    // The signing step runs `security` and `codesign` with no network
    // (decision 2 of docs/design/apple-devices.md); every other Apple launch
    // keeps the toolchain port's own egress.
    const appleSigningProcess = new RepositoryTestProcessPort({
      receiptDirectory: join(providerDataDirectory, "apple-runtime", "signing-receipts"),
      literalReadPaths: APPLE_TOOLCHAIN_HOST_READ_PATHS,
      networkEgress: "none",
    });
    yield* Effect.promise(() => appleSigningProcess.reconcile());
    // A lease ends with the thread it was confirmed for: archived, purged, or
    // bound to another checkout than the one the person saw.
    const unsubscribeAppleDeviceLeases = persistence.journal.subscribeCommitted((append) => {
      for (const event of append.events) {
        if (event.eventName === "code.thread-updated@1" && event.aggregateType === "code-thread") {
          const thread = persistence.readCodeThread(decodeCodeThreadId(event.aggregateId));
          if (thread === undefined || thread.lifecycle !== "active") {
            appleDeviceLeases.threadSettled(event.aggregateId, "thread-archived");
          } else {
            appleDeviceLeases.threadCheckout(event.aggregateId, String(thread.checkoutId));
          }
        } else if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
          const purged = event.payload as { readonly mode?: unknown; readonly threadId?: unknown };
          if (purged.mode === "code" && typeof purged.threadId === "string") {
            appleDeviceLeases.threadSettled(purged.threadId, "thread-purged");
          }
        }
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeAppleDeviceLeases));
    const appleToolchainService = new AppleToolchainService({
      execute: (input, signal) => appleProcess.execute(input, signal),
      ...(simulatorDevice === undefined
        ? {}
        : { injectSimulatorInput: simulatorInputThroughDesktop(simulatorDevice) }),
      observeSimulators: (simulators) => simulatorInputGrants.closeUnlessBooted(simulators),
      captureDirectory: appleCaptureDirectory,
      isolatedRoots: [devicectlOutputDirectory, deviceCaptureDirectory, appleSigningDirectory],
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
      evidence:
        | import("@octant/contracts").AppleBuildEvidence
        | import("@octant/contracts").AppleDeviceEvidence,
      startedAt: string,
    ) => {
      const composed = composeAppleValidationEvents({ evidence, startedAt, newId: randomUUID });
      appleValidationEvents.appendPlan({ plan: composed.plan, expectedVersion: 0 });
      appleValidationEvents.appendEvidence({ evidence: composed.record, expectedVersion: 1 });
      appleValidationEvents.appendReport({ report: composed.report, expectedVersion: 2 });
    };
    const appleDeviceService = new AppleDeviceService({
      execute: (input, signal) => appleProcess.execute(input, signal),
      executeSigning: (input, signal) => appleSigningProcess.execute(input, signal),
      outputDirectory: devicectlOutputDirectory,
      captureDirectory: deviceCaptureDirectory,
      artifactRoot: appleRuntimeStore.artifactRoot,
      signingDirectory: appleSigningDirectory,
      // Where Xcode installs the person's provisioning profiles, the newer
      // location first. Octant reads them and never writes there.
      provisioningProfileDirectories: [
        join(homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"),
        join(homedir(), "Library", "MobileDevice", "Provisioning Profiles"),
      ],
      isolatedRoots: [appleCaptureDirectory],
      identities: appleRuntimeStore,
      leases: appleDeviceLeases,
      realpath,
      writeArtifact: (reference, bytes) => appleRuntimeStore.writeArtifact(reference, bytes),
      readArtifact: (reference) => appleRuntimeStore.readArtifact(reference),
      recordEvidence: recordAppleEvidence,
      now: () => new Date().toISOString(),
      newId: randomUUID,
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => appleDeviceService.close()));
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
      // for the Simulator and for a physical device.
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
      const { resolveAppleDeviceScope, resolveAppleDeviceAgentScope } = createAppleDeviceScopes({
        resolveThread: resolveAppleThread,
        effectiveThread: (windowId, thread) =>
          codeSessionAuthority.effectiveThread(windowId, thread),
        approvals,
      });
      // The thread and checkout whose held screenshots and console reads a
      // caller may read back.
      const resolveAppleDeviceThread = async (
        windowId: WindowId,
        scope: Parameters<typeof resolveAppleThread>[1],
      ) => {
        const resolved = await resolveAppleThread(windowId, scope);
        return resolved === undefined
          ? undefined
          : { threadId: resolved.thread.id, checkoutId: resolved.checkout.id };
      };
      const appleDeviceRoutes = createAppleDeviceRouteHandler({
        windowAuthorityStore,
        service: appleDeviceService,
        resolveScope: resolveAppleDeviceScope,
        // A screenshot's pixels are read in the same thread scope, by a local
        // window only; the route refuses every other principal first.
        resolveThread: resolveAppleDeviceThread,
      });
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
        appleDeviceRoutes,
        appleToolchainRoutes,
        resolveAndroidContext,
        resolveAppleContext,
        resolveAppleDeviceAgentScope,
        resolveAppleDeviceThread,
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
      appleDeviceService,
      appleToolchainService,
      bindDeviceApprovals,
      recordAppleEvidence,
    };
  });
}

export type DevicesWiring = Effect.Effect.Success<ReturnType<typeof wireDevices>>;
