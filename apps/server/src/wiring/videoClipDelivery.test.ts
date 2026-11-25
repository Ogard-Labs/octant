import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeThread,
  decodeProject,
  decodeProviderInstanceId,
  decodeVideoJob,
  decodeVideoModelCapabilities,
  decodeWindowId,
  decodeWorkThread,
  LOCAL_HOST_ID,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
  type CodeThread,
  type ProviderInstance,
  type ProviderObservedState,
  type WorkThread,
} from "@octant/contracts";
import { contextKeyForProject, defaultWindowWorkspace } from "@octant/domain";
import { CREATE_VIDEO_TOOL_NAME } from "@octant/plugin-host/media-tools";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import * as codeOperationRuntime from "../code/codeOperationRuntime";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { startOctantServer } from "../server";
import type { VideoJobService } from "../video/videoJobService";
import * as workTurnService from "../work/workTurnService";
import * as code from "./codeRuntime";
import * as work from "./work";

const now = "2026-11-25T10:00:00.000Z";
const profileId = decodeProviderInstanceId(randomUUID());
const model = decodeVideoModelCapabilities({
  modelId: "gemini-omni-1.2-flash",
  displayName: "Gemini Omni Flash",
  durations: { kind: "range", min: 3, max: 15 },
  resolutions: ["720p"],
  aspectRatios: [{ ratio: "16:9" }],
  audio: "always",
  inputs: { firstFrame: false, lastFrame: false, maxReferenceImages: 0 },
  price: { kind: "unpublished" },
  job: { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 },
});
const profile: ProviderInstance = {
  id: profileId,
  displayName: "Gemini Video",
  enabled: true,
  environmentPolicy: "inherit-host",
  version: 1 as ProviderInstance["version"],
  createdAt: now as ProviderInstance["createdAt"],
  updatedAt: now as ProviderInstance["updatedAt"],
  driverKind: "gemini-video",
  configuration: {
    kind: "gemini-video-http",
    modelAllowlist: [model.modelId],
    defaultModel: model.modelId,
  },
};

/** A video service whose clips finish at once, for whichever thread asked. */
function finishedClips() {
  const enqueue = vi.fn<VideoJobService["enqueue"]>(async (input) =>
    decodeVideoJob({
      id: randomUUID(),
      status: "completed",
      threadKind: input.threadKind,
      scopeId: input.scopeId,
      profileInstanceId: input.profileInstanceId,
      driverKind: "gemini-video",
      modelId: input.modelId,
      promptHash: "a".repeat(64),
      options: input.options,
      imageCount: 0,
      estimatedCostUsdMicros: "unknown",
      clip: {
        clipId: randomUUID(),
        hash: "b".repeat(64),
        size: 2048,
        durationSeconds: input.options.durationSeconds,
        resolution: input.options.resolution,
        aspectRatio: input.options.aspectRatio,
      },
      providerCopy: "removed",
      version: 2,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const jobs: Partial<VideoJobService> = {
    readyProfilesNow: () => [{ instance: profile, models: [model] }],
    quote: async () => ({
      status: "ready",
      driverKind: "gemini-video",
      profileName: "Gemini Video",
      providerName: "Google",
      model,
      estimate: { kind: "unknown" },
    }),
    enqueue,
    whenTerminal: async () => enqueue.mock.results.at(-1)?.value,
    stop: () => undefined,
  };
  return { enqueue, service: jobs as VideoJobService };
}

it("marks the Work and Code thread a finished clip was delivered to, and no other", async () => {
  const directory = mkdtempSync(join(tmpdir(), "octant-clip-delivery-"));
  const windowId = decodeWindowId(randomUUID());
  const clips = finishedClips();
  const observed = {
    readiness: "ready",
    models: [],
    capabilities: { appManagedTools: "supported" },
  } as unknown as ProviderObservedState;
  let workDependencies:
    | ConstructorParameters<typeof workTurnService.WorkTurnService>[0]
    | undefined;
  let codeOptions:
    | Parameters<typeof codeOperationRuntime.createCodeOperationRuntime>[0]
    | undefined;
  let runningWorkTurns: Parameters<typeof work.wireWork>[0]["runningWorkTurns"] | undefined;
  const { WorkTurnService } = workTurnService;
  const { createCodeOperationRuntime } = codeOperationRuntime;
  const { wireWork } = work;
  const { wireCodeRuntime } = code;
  const spies = [
    vi.spyOn(workTurnService, "WorkTurnService").mockImplementation(function (dependencies) {
      workDependencies = dependencies;
      return new WorkTurnService(dependencies);
    }),
    vi.spyOn(codeOperationRuntime, "createCodeOperationRuntime").mockImplementation((options) => {
      codeOptions = options;
      return createCodeOperationRuntime(options);
    }),
    vi.spyOn(work, "wireWork").mockImplementation((deps) => {
      vi.spyOn(deps.providerRuntimeRegistry, "observedState").mockReturnValue(observed);
      deps.windowAuthorityStore.register({
        windowId,
        capability: "A".repeat(43),
        now: Date.now(),
      });
      runningWorkTurns = deps.runningWorkTurns;
      return wireWork({ ...deps, videoJobService: clips.service });
    }),
    vi
      .spyOn(code, "wireCodeRuntime")
      .mockImplementation((deps) => wireCodeRuntime({ ...deps, videoJobService: clips.service })),
  ];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const append = (
            aggregateType: string,
            aggregateId: string,
            eventName: string,
            payload: unknown,
          ) =>
            persistence.journal.append({
              aggregate: { aggregateType, aggregateId },
              expectedVersion: 0,
              events: [
                {
                  eventId: randomUUID(),
                  eventName,
                  eventVersion: 1,
                  correlationId: randomUUID(),
                  actor: { kind: "local-user", actorId: windowId },
                  occurredAt: now,
                  payload,
                },
              ],
            });
          const makeProject = (mode: "work" | "code") => {
            const root = join(directory, mode);
            mkdirSync(root);
            const project = decodeProject({
              id: randomUUID(),
              type: mode,
              name: mode,
              lifecycle: "active",
              pinned: false,
              rank: "0/1",
              version: 1,
              createdAt: now,
              updatedAt: now,
              binding: { canonicalRoot: root },
              bindingHistory: [
                {
                  revisionId: randomUUID(),
                  revision: 1,
                  currentBinding: { canonicalRoot: root },
                  actor: { kind: "local-user", actorId: windowId },
                  changedAt: now,
                },
              ],
              ...(mode === "code" ? { codeAccessPersistence: "current-session" } : {}),
            });
            if (project.type === "chat") throw new Error("A clip is saved in a task Project.");
            append("project", project.id, "project.created@1", { project });
            const common = {
              id: randomUUID(),
              projectId: project.id,
              bindingRevisionId: project.bindingHistory.at(-1)?.revisionId,
              title: mode,
              lifecycle: "active",
              providerInstanceId: randomUUID(),
              modelId: "model",
              version: 1,
              createdAt: now,
              updatedAt: now,
            };
            return { project, root, common };
          };
          const workProject = makeProject("work");
          const codeProject = makeProject("code");
          const workThread: WorkThread = decodeWorkThread({
            ...workProject.common,
            access: "full-access",
          });
          const codeThread: CodeThread = decodeCodeThread({
            ...codeProject.common,
            repositoryId: `repo_${"a".repeat(64)}`,
            checkoutId: randomUUID(),
            executionPolicy: "full-access",
            permissionPersistence: "current-session",
            deliveryTarget: {
              branchIntent: "feature/task",
              remoteName: "origin",
              proposedBaseRepository: "org/repo",
              proposedBaseBranch: "main",
              outcomeKind: "opened-pr",
              confirmedAt: now,
            },
          });
          append("work-thread", workThread.id, "work.thread-created@1", {
            kind: "thread-created",
            thread: workThread,
          });
          append("code-thread", codeThread.id, "code.thread-created@1", {
            kind: "thread-created",
            thread: codeThread,
          });
          const workspace = defaultWindowWorkspace(windowId);
          append("window-workspace", windowId, "workspace.layout-replaced", {
            workspace: {
              ...workspace,
              version: 1,
              contextByMode: {
                ...workspace.contextByMode,
                work: contextKeyForProject(
                  "work",
                  LOCAL_HOST_ID,
                  workProject.project.id,
                  workProject.root,
                ),
                code: contextKeyForProject(
                  "code",
                  LOCAL_HOST_ID,
                  codeProject.project.id,
                  codeProject.root,
                ),
              },
            },
          });
          yield* startOctantServer({
            hostname: "127.0.0.1",
            port: 0,
            serve: () =>
              // No socket, browser or provider is launched.
              ({ url: new URL("http://127.0.0.1:13774"), stop: () => undefined }),
          });

          const marked: Array<string> = [];
          persistence.journal.subscribeCommitted((committed) => {
            for (const event of committed.events) {
              if (event.eventName !== THREAD_EXTERNAL_CONTENT_EVENT_NAMES.ingested) continue;
              marked.push(String(event.aggregateId));
            }
          });
          const makeClip = async (tools: AppManagedToolSet | undefined) =>
            tools?.execute({
              name: CREATE_VIDEO_TOOL_NAME,
              inputJson: JSON.stringify({ prompt: "A paper boat on a pond" }),
            });
          // A running turn's level decides whether a card is asked for; nobody answers one here.
          runningWorkTurns?.set(String(workThread.id), {
            requestId: randomUUID(),
            access: "full-access",
          });
          const workTools = workDependencies?.resolveAppManagedTools?.({
            thread: workThread,
            projectRoot: workProject.root,
            windowId,
            turnId: randomUUID() as never,
          });
          expect(yield* Effect.promise(() => makeClip(workTools))).toMatchObject({
            result: { status: "completed" },
          });
          expect(marked).toEqual([String(workThread.id)]);
          const codeTools = codeOptions?.contributedTools?.({
            windowId,
            thread: codeThread,
            readThread: () => persistence.readCodeThread(codeThread.id),
            folders: [codeProject.root],
            askPerson: async () => "denied",
          });
          expect(yield* Effect.promise(() => makeClip(codeTools))).toMatchObject({
            result: { status: "completed" },
          });
          expect(marked).toEqual([String(workThread.id), String(codeThread.id)]);
          expect(
            clips.enqueue.mock.calls.map(([input]) => [input.threadKind, String(input.scopeId)]),
          ).toEqual([
            ["work-thread", String(workThread.id)],
            ["code-thread", String(codeThread.id)],
          ]);
        }),
      ).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
