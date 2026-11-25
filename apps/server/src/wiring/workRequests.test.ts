import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeChatThreadId,
  decodeProjectId,
  decodeStableHostId,
  decodeWindowId,
  decodeWorkThread,
  DeviceId,
  RemoteSessionId,
  ServiceOffer,
  type WindowId,
} from "@octant/contracts";
import { PENDING_REQUEST_SERVICE_OFFERS_MEDIA_TYPE } from "@octant/contracts/pending-requests";
import { defaultWindowWorkspace } from "@octant/domain";
import { windowAdmitsProject } from "@octant/domain/shell-policy";
import { assertReadableChatThread } from "../chat/chatService";
import {
  createRemoteDevicePrincipal,
  principalActsAsHostPerson,
  type ClientPrincipal,
} from "../clientPrincipal";
import { createHubActScopeSlot } from "../hub/hubActScope";
import { chatImageScopeAllowedForWindow } from "../image/imageScopeAuthority";
import { ServiceOfferService } from "../offers/serviceOfferService";
import { makePersistenceLive, Persistence } from "../persistence/persistenceService";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createActiveWorkProjects } from "../activeWork/activeWorkProjects";
import { wireWorkRequests, type WorkRequestsDependencies } from "./workRequests";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("wireWorkRequests service offers", () => {
  it("lists a person-paired device's waiting Chat offer and gives the menu bar each saved window's offers that window can still open", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "octant-work-requests-"));
    tempDirs.push(dataDirectory);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const now = new Date().toISOString();
          const actor = { kind: "local-user" as const, actorId: randomUUID() };

          const pairedThreadId = randomUUID();
          const localThreadId = randomUUID();
          const projectThreadId = randomUUID();
          const otherProjectId = randomUUID();
          for (const [id, title, projectId] of [
            [pairedThreadId, "Phone chat", undefined],
            [localThreadId, "Desktop chat", undefined],
            [projectThreadId, "Project chat", otherProjectId],
          ] as const) {
            persistence.journal.append({
              aggregate: { aggregateType: "chat-thread", aggregateId: id },
              expectedVersion: 0,
              events: [
                {
                  eventId: randomUUID(),
                  eventName: "chat.thread-created@1",
                  eventVersion: 1,
                  correlationId: randomUUID(),
                  actor,
                  occurredAt: now,
                  payload: {
                    kind: "thread-created",
                    thread: {
                      id,
                      title,
                      ...(projectId === undefined ? {} : { projectId }),
                      lifecycle: "active",
                      providerInstanceId: randomUUID(),
                      modelId: "fixture",
                      researchEnabled: false,
                      researchRouting: "automatic",
                      personalityInstructions: "Be concise.",
                      version: 1,
                      createdAt: now,
                      updatedAt: now,
                    },
                  },
                },
              ],
            });
          }

          const localWindowId = decodeWindowId(randomUUID());
          // A second saved window whose offer waits on a Chat thread in a
          // Project its own layout does not reach, so it cannot open that thread.
          const refusedWindowId = decodeWindowId(randomUUID());
          const menuBarWindowId = decodeWindowId(randomUUID());
          const menuBarCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
          for (const windowId of [localWindowId, refusedWindowId]) {
            persistence.journal.append({
              aggregate: { aggregateType: "window-workspace", aggregateId: String(windowId) },
              expectedVersion: 0,
              events: [
                {
                  eventId: randomUUID(),
                  eventName: "workspace.layout-replaced",
                  eventVersion: 1,
                  correlationId: randomUUID(),
                  actor,
                  occurredAt: now,
                  payload: { workspace: { ...defaultWindowWorkspace(windowId), version: 1 } },
                },
              ],
            });
          }

          const deviceId = Schema.decodeUnknownSync(DeviceId)(randomUUID());
          const deviceScope = decodeWindowId(String(deviceId));
          const pairedPrincipal = createRemoteDevicePrincipal({
            hostId: decodeStableHostId(randomUUID()),
            deviceId,
            credentialGeneration: 1,
            origin: "https://octant.example",
            protocolVersion: 1,
            capabilityDigest: "a".repeat(64),
            sessionId: Schema.decodeUnknownSync(RemoteSessionId)(randomUUID()),
            admittedBy: "host-person",
          });

          const windowAuthorityStore = new WindowAuthorityStore();
          windowAuthorityStore.register({
            windowId: menuBarWindowId,
            capability: menuBarCapability,
            now: Date.now(),
          });

          const serviceOffers = new ServiceOfferService<ServiceOffer, unknown>(8, {
            uuid: randomUUID,
            now: Date.now,
          });
          const profileId = randomUUID();
          const makeOffer = (
            scopeId: string,
            prompt: string,
            offerId: string,
            requestedAt: string,
          ): ServiceOffer =>
            Schema.decodeUnknownSync(ServiceOffer)({
              kind: "generate",
              offerId,
              threadKind: "chat-thread",
              scopeId,
              prompt,
              variantCount: 1,
              revision: false,
              suggested: { profileInstanceId: profileId, modelId: "fixture" },
              requestedAt,
            });
          const pairedWait = serviceOffers.wait({
            windowId: deviceScope,
            stamp: (offerId, requestedAt) =>
              makeOffer(pairedThreadId, "Paired sunset", offerId, requestedAt),
          });
          const localWait = serviceOffers.wait({
            windowId: localWindowId,
            stamp: (offerId, requestedAt) =>
              makeOffer(localThreadId, "Desktop skyline", offerId, requestedAt),
          });
          const refusedWait = serviceOffers.wait({
            windowId: refusedWindowId,
            stamp: (offerId, requestedAt) =>
              makeOffer(projectThreadId, "Project harbour", offerId, requestedAt),
          });

          // Mirrors wireContext's Chat access rule: paired devices have no desktop
          // workspace row and depend on `principal` being threaded from the route.
          const windowCanOpenThread = async (
            windowId: WindowId,
            threadKind: "chat-thread" | "work-thread" | "code-thread",
            threadId: string,
            principal?: ClientPrincipal,
          ): Promise<boolean> => {
            if (threadKind !== "chat-thread") return false;
            if (principal?.kind === "remote-device") {
              if (
                !principalActsAsHostPerson(principal) ||
                String(principal.deviceId) !== String(windowId)
              ) {
                return false;
              }
              return (
                assertReadableChatThread(persistence, decodeChatThreadId(threadId)) !== undefined
              );
            }
            const thread = persistence.readChatThread(decodeChatThreadId(threadId));
            const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
            return chatImageScopeAllowedForWindow({
              chatAdmits:
                workspace === undefined
                  ? undefined
                  : (projectId) =>
                      windowAdmitsProject(
                        workspace,
                        "chat",
                        projectId === null ? null : decodeProjectId(projectId),
                      ),
              thread,
            });
          };

          const emptyList = () => [];
          const emptyAsync = async () => [];
          const wired = wireWorkRequests({
            hubActScopeSlot: createHubActScopeSlot(),
            persistence,
            windowAuthorityStore,
            serviceOffers,
            windowCanOpenThread,
            providerDataDirectory: dataDirectory,
            isProjectPolicyTargetAllowed: () => false,
            decisionReviewModelPort: {
              chosenModel: () => undefined,
              accountUnavailable: () => false,
              keptOutOfMemory: () => false,
              providerIdentity: () => undefined,
              redact: (text: string) => text,
              complete: async () => "",
              recordUsage: () => undefined,
            },
            agentRunPersistence: { getById: () => undefined },
            agentRunInteractions: { mayAnswerFromDevice: () => false },
            extensionToolApprovalService: { list: emptyList },
            routineProposalService: { list: emptyList },
            threadSecrets: { waiting: emptyList },
            browserToolApprovalService: { list: emptyList },
            workRequestService: {
              interruptProject: () => undefined,
              listForThread: emptyList,
              listPendingForProject: emptyList,
            },
            gitObservationPort: {},
            goalService: { read: () => ({ goal: undefined }) },
            projectMemoryAccess: { proposals: { list: emptyList } },
            projectService: {
              onWorkProjectArchived: () => () => undefined,
              hasActiveProject: () => false,
              bootstrap: async () => ({ active: [], archived: [] }),
            },
            workProjectStatusReader: {},
            codeActiveWorkForWindow: emptyAsync,
            baseRouteCodeService: {
              navigation: async () => ({ threads: [], runtime: [] }),
            },
            codeOperationRuntime: { pendingRequests: emptyAsync },
            codeTurnDecisions: { listForWindow: emptyAsync },
            routeCodeService: {},
            nativeHarnessApprovals: { listAll: emptyList, waiting: emptyList },
            nativeHarnessQuestions: { listAll: emptyList, waiting: emptyList },
            nativeHarnessSessions: {
              read: () => undefined,
              threadsWithPendingLeadApprovals: emptyList,
            },
            chatService: {
              listPendingQuestions: emptyList,
              listsActiveThread: () => false,
              navigation: () => ({ threads: [] }),
              listSearchableThreads: emptyList,
            },
            observeWorkThreadRuntime: () => undefined,
            workflowService: {},
            workThreadService: {
              bootstrap: async () => ({ threads: [] }),
              listSearchableThreads: emptyList,
            },
            workThreadServiceWithWorkflows: {
              navigation: async () => ({ threads: [], runtime: [] }),
            },
            workResearchProjection: { snapshot: () => new Map() },
            finishedReceipts: { boardMark: () => undefined },
            workArtifactProjection: { snapshot: () => new Map() },
            workThreadProjection: { read: () => undefined, list: emptyList },
            workTurnProjection: { listForThread: emptyList },
          } as unknown as WorkRequestsDependencies);

          try {
            // 1. Person-paired device sees its own Chat offer in /api/pending-requests
            // and /api/fleet-activity, and does not see the local desktop window's offer.
            const pairedPendingRequest = new Request("http://127.0.0.1/api/pending-requests", {
              headers: { accept: PENDING_REQUEST_SERVICE_OFFERS_MEDIA_TYPE },
            });
            bindPrincipalRouteContext(pairedPendingRequest, {
              principal: pairedPrincipal,
              scopeId: deviceScope,
            });
            const pairedPendingResponse = yield* Effect.promise(() =>
              wired.pendingRequestRoutes(pairedPendingRequest),
            );
            expect(pairedPendingResponse?.status).toBe(200);
            const pairedPendingBody = yield* Effect.promise(
              async () =>
                (await pairedPendingResponse?.json()) as {
                  asks?: ReadonlyArray<{
                    kind: string;
                    mode: string;
                    threadId: string;
                    threadTitle: string;
                  }>;
                },
            );
            expect(pairedPendingBody.asks).toEqual([
              expect.objectContaining({
                kind: "service-offer",
                mode: "chat",
                threadId: pairedThreadId,
                threadTitle: "Phone chat",
              }),
            ]);

            const pairedFleetRequest = new Request("http://127.0.0.1/api/fleet-activity");
            bindPrincipalRouteContext(pairedFleetRequest, {
              principal: pairedPrincipal,
              scopeId: deviceScope,
            });
            const pairedFleetResponse = yield* Effect.promise(() =>
              wired.fleetActivityRoutes(pairedFleetRequest),
            );
            expect(pairedFleetResponse?.status).toBe(200);
            const pairedFleetBody = yield* Effect.promise(
              async () =>
                (await pairedFleetResponse?.json()) as {
                  threads: ReadonlyArray<{
                    mode: string;
                    threadId: string;
                    title: string;
                    state: string;
                  }>;
                },
            );
            expect(pairedFleetBody.threads).toEqual([
              expect.objectContaining({
                mode: "chat",
                threadId: pairedThreadId,
                title: "Phone chat",
                state: "needs-you",
              }),
            ]);

            // 2. Menu bar (a separate local window with no offers of its own) sees the
            // local desktop window's waiting offer in /api/fleet-activity, not the paired
            // device's, and not the offer whose thread its own window can no longer open.
            const menuBarFleetRequest = new Request("http://127.0.0.1/api/fleet-activity", {
              headers: { "x-octant-window-capability": menuBarCapability },
            });
            const menuBarFleetResponse = yield* Effect.promise(() =>
              wired.fleetActivityRoutes(menuBarFleetRequest),
            );
            expect(menuBarFleetResponse?.status).toBe(200);
            const menuBarFleetBody = yield* Effect.promise(
              async () =>
                (await menuBarFleetResponse?.json()) as {
                  threads: ReadonlyArray<{
                    mode: string;
                    threadId: string;
                    title: string;
                    state: string;
                  }>;
                },
            );
            expect(menuBarFleetBody.threads).toEqual([
              expect.objectContaining({
                mode: "chat",
                threadId: localThreadId,
                title: "Desktop chat",
                state: "needs-you",
              }),
            ]);
          } finally {
            serviceOffers.close();
            yield* Effect.promise(() => Promise.all([pairedWait, localWait, refusedWait]));
          }
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory }))),
      ),
    );
  });
});

describe("wireWorkRequests active work", () => {
  it("says each Work thread's board state, under the sidebar's own list, and none that is Done or put away", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "octant-active-work-"));
    tempDirs.push(dataDirectory);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const now = new Date().toISOString();
          const projectId = decodeProjectId(randomUUID());
          const bindingRevisionId = randomUUID();
          const thread = (title: string, extra: Record<string, unknown> = {}) =>
            decodeWorkThread({
              id: randomUUID(),
              projectId,
              bindingRevisionId,
              title,
              lifecycle: "active",
              providerInstanceId: randomUUID(),
              modelId: "fixture",
              workingDirectory: ".",
              version: 1,
              createdAt: now,
              updatedAt: now,
              ...extra,
            });
          const threads = [
            thread("Idle"),
            thread("Running"),
            thread("Asking"),
            thread("Stopped"),
            thread("Rebound", { bindingRevisionId: randomUUID() }),
            thread("Done", { completionConfirmed: true }),
            thread("Settled", { completedAt: now }),
          ];
          // A turn that moved after every thread record, as a running turn's
          // progress does, dates its thread as the board dates its card.
          const lastTurn = new Date(Date.parse(now) + 60_000).toISOString();
          const lastGoal = new Date(Date.parse(now) + 120_000).toISOString();
          const titleOf = (threadId: unknown) =>
            threads.find((entry) => String(entry.id) === String(threadId))?.title;
          const windowId = decodeWindowId(randomUUID());
          const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
          const windowAuthorityStore = new WindowAuthorityStore();
          windowAuthorityStore.register({ windowId, capability, now: Date.now() });
          const emptyList = () => [];
          const wired = wireWorkRequests({
            hubActScopeSlot: createHubActScopeSlot(),
            persistence,
            windowAuthorityStore,
            providerDataDirectory: dataDirectory,
            agentRunPersistence: { listCenterCandidates: emptyList },
            agentRunOrchestration: { waitsOnItsOwn: () => () => false },
            decisionReviewModelPort: {},
            workRequestService: { listForThread: emptyList },
            goalService: {
              read: (threadId: string) => ({
                goal:
                  titleOf(threadId) === "Asking"
                    ? { status: "active", objective: "Ship it", updatedAt: lastGoal }
                    : null,
              }),
            },
            projectService: {
              onWorkProjectArchived: () => () => undefined,
              bootstrap: async () => ({
                active: [{ id: projectId, type: "work", name: "Reports", bindingRevisionId }],
              }),
            },
            workProjectStatusReader: { hasDueItems: async () => false },
            codeActiveWorkForWindow: async () => [],
            activeWorkProjects: createActiveWorkProjects({
              readProjects: () => [
                {
                  id: projectId,
                  type: "work",
                  name: "Reports",
                  lifecycle: "active",
                  bindingRevisionId,
                },
              ],
              bootstrap: async () => ({ active: [] }),
            }),
            codeTurnDecisions: {},
            baseRouteCodeService: {},
            routeCodeService: {},
            chatService: { navigation: () => ({ threads: [] }) },
            observeWorkThreadRuntime: (threadId: unknown) => ({
              executing: titleOf(threadId) === "Running",
              awaitingInput: titleOf(threadId) === "Asking",
              interrupted: titleOf(threadId) === "Stopped",
            }),
            workflowService: {},
            workThreadService: {},
            workThreadServiceWithWorkflows: {
              navigation: async () => ({ threads, runtime: [] }),
              bootstrap: async () => ({ threads, runtime: [] }),
            },
            workResearchProjection: { snapshot: () => new Map() },
            finishedReceipts: { boardMark: () => undefined },
            workArtifactProjection: { snapshot: () => new Map() },
            workThreadProjection: { read: () => undefined, list: emptyList },
            workTurnProjection: {
              listForThread: (threadId: unknown) =>
                titleOf(threadId) === "Idle" ? [{ updatedAt: lastTurn }] : [],
            },
          } as unknown as WorkRequestsDependencies);
          const headers = { "x-octant-window-capability": capability };
          const answer = yield* Effect.promise(async () => {
            const response = await wired.activeWorkRoutes(
              new Request("http://127.0.0.1/api/active-work", { headers }),
            );
            expect(response?.status).toBe(200);
            return (await response?.json()) as {
              rows: ReadonlyArray<{
                title: string;
                projectName: string;
                board: { status: string };
                updatedAt: string;
              }>;
            };
          });
          const board = yield* Effect.promise(async () => {
            const response = await wired.workThreadRoutes(
              new Request("http://127.0.0.1/api/work/board", {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify({ version: 1 }),
              }),
            );
            expect(response?.status).toBe(200);
            return (await response?.json()) as {
              cards: ReadonlyArray<{ title: string; status: string; statusReason: string }>;
            };
          });
          expect(Object.fromEntries(answer.rows.map((row) => [row.title, row.board]))).toEqual(
            Object.fromEntries(
              board.cards
                .filter((card) => card.status !== "done")
                .map((card) => [card.title, { status: card.status, reason: card.statusReason }]),
            ),
          );
          expect(answer.rows.map((row) => row.title).toSorted()).toEqual([
            "Asking",
            "Idle",
            "Rebound",
            "Running",
            "Stopped",
          ]);
          expect(answer.rows[0]?.projectName).toBe("Reports");
          const ready = answer.rows.filter((row) => row.board.status === "ready");
          expect(ready.map((row) => row.title)).toEqual(["Idle"]);
          expect(ready[0]?.updatedAt).toBe(lastTurn);
          expect(answer.rows.find((row) => row.title === "Asking")?.updatedAt).toBe(lastGoal);
        }).pipe(Effect.provide(makePersistenceLive({ dataDirectory }))),
      ),
    );
  });
});
