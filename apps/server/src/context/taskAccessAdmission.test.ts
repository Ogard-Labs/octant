import { Schema } from "effect";
import { createContextClient } from "@octant/client-runtime/context-client";
import type { CodeThread, Project } from "@octant/contracts";
import { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import { createTaskAccessSubjectReader } from "./taskAccessSubject";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { describe, expect, it, vi } from "vitest";
import {
  decodeContextSubjectRef,
  decodeProjectId,
  decodeWindowId,
  decodeProviderInstanceId,
  decodeProviderModelId,
} from "@octant/contracts";
import { DeviceId, StableHostId, RemoteSessionId } from "@octant/contracts/remote-access";
import { contextKeyForProject, defaultWindowWorkspace } from "@octant/domain";
import { resolveGuardrail } from "@octant/domain/guardrail-policy";
import { createContextRouteHandler } from "../contextRoutes";
import { createTaskAccessFacts } from "./taskAccessFacts";
import { CodeProjectAccess } from "../codeProjectAccess";
import { createAuthenticatedProductDispatch } from "../authenticatedProductRoutes";
import { bindPrincipalRouteContext, resolvePrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore, WINDOW_AUTHORITY_TTL_MS } from "../windowAuthorityStore";

const scope = decodeWindowId("82000000-0000-4000-8000-000000000001");
const project = decodeProjectId("82000000-0000-4000-8000-000000000020");
const otherProject = decodeProjectId("82000000-0000-4000-8000-000000000021");
const subject = decodeContextSubjectRef({
  aggregateType: "code-thread",
  aggregateId: "82000000-0000-4000-8000-000000000002",
});
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const remotePrincipal = {
  kind: "remote-device" as const,
  deviceId: Schema.decodeUnknownSync(DeviceId)(scope),
  hostId: Schema.decodeUnknownSync(StableHostId)("82000000-0000-4000-8000-000000000030"),
  credentialGeneration: 1,
  origin: "https://octant.example",
  protocolVersion: 1,
  capabilityDigest: "b".repeat(64),
  sessionId: Schema.decodeUnknownSync(RemoteSessionId)("82000000-0000-4000-8000-000000000031"),
};

function setup(remote = false) {
  let now = 1;
  const store = new WindowAuthorityStore();
  store.register({ windowId: scope, capability, now });
  const baseline = defaultWindowWorkspace(scope);
  let workspace = {
    ...baseline,
    contextByMode: {
      ...baseline.contextByMode,
      code: contextKeyForProject("code", LOCAL_HOST_ID, project, "/repo"),
    },
  };
  let taskProject = project;
  let projectActive = true;
  let hold: Promise<void> = Promise.resolve();
  const entered = Promise.withResolvers<void>();
  const access = new CodeProjectAccess({
    readWorkspace: () => (remote ? undefined : workspace),
    isWindowLive: () => store.listWindowIds().some((id) => id === scope),
    hasActiveCodeProject: (id) => projectActive && id === project,
  });
  const privateRead = vi.fn(() => undefined);
  const subjectReader = createTaskAccessSubjectReader({
    code: () =>
      ({
        id: subject.aggregateId,
        lifecycle: "active",
        projectId: taskProject,
        executionPolicy: "approval-gated",
        autoApprove: true,
        providerInstanceId: decodeProviderInstanceId("82000000-0000-4000-8000-000000000010"),
        modelId: decodeProviderModelId("main-model"),
      }) as unknown as CodeThread,
    work: () => undefined,
    project: () =>
      ({
        id: taskProject,
        type: "code",
        lifecycle: projectActive ? "active" : "archived",
      }) as unknown as Project,
    codeSettings: () => undefined,
    workSettings: () => undefined,
    canAccessCodeProject: (scopeId, projectId) => access.canAccessProject(scopeId, projectId),
    session: new CodeSessionAuthorityStore(),
    activeCode: (thread) => ({ ...thread, executionPolicy: "plan" }),
    runningWork: () => undefined,
    tainted: () => false,
  });
  const facts = createTaskAccessFacts({
    subject: subjectReader,
    instance: privateRead,
    observed: () => undefined,
    reviewer: (_id, posture) => ({
      resolution: resolveGuardrail({
        access: posture,
        capabilities: { providerReview: false, providerSandbox: false },
      }),
      modelUnavailable: false,
    }),
    clock: () => "2026-11-02T21:00:00.000Z",
  });
  const route = createContextRouteHandler({
    service: {
      inspect: () => {
        throw new Error("No plan should be needed");
      },
      execute: () => {
        throw new Error("No mutation should occur");
      },
      compactionState: () => {
        throw new Error("No compaction");
      },
      taskAccess: (target, _principal, windowId) => facts(target, windowId),
    },
    windowAuthorityStore: store,
    windowCanOpenProject: async () => false,
    windowCanOpenThread: async (windowId) => {
      const admitted = access.canAccessProject(windowId, taskProject);
      entered.resolve();
      await hold;
      return admitted;
    },
    now: () => now,
  });
  const request = () =>
    new Request("http://127.0.0.1/api/context/inspect", {
      method: "POST",
      headers: { "content-type": "application/json", "x-octant-window-capability": capability },
      body: JSON.stringify({ subject, view: "task-access" }),
    });
  const dispatch = (input = request()) => {
    const context = resolvePrincipalRouteContext({ request: input, store, now });
    bindPrincipalRouteContext(input, context);
    return access.run(context, () => route(input));
  };
  const remoteDispatch = createAuthenticatedProductDispatch({
    dispatch: (input, context) => access.run(context, () => route(input)),
  });
  return {
    dispatch,
    remoteDispatch: (signal?: AbortSignal) =>
      remoteDispatch({
        principal: remotePrincipal,
        request: request(),
        ...(signal === undefined ? {} : { abortSignal: signal }),
      }),
    privateRead,
    store,
    entered: entered.promise,
    waitOn: (promise: Promise<void>) => {
      hold = promise;
    },
    revoke: () => store.revoke(scope),
    expire: () => {
      now += WINDOW_AUTHORITY_TTL_MS + 1;
    },
    rotate: () => {
      store.revoke(scope);
      store.register({
        windowId: scope,
        capability: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
        now,
      });
    },
    moveWindow: () => {
      workspace = {
        ...workspace,
        contextByMode: {
          ...workspace.contextByMode,
          code: contextKeyForProject("code", LOCAL_HOST_ID, otherProject, "/other"),
        },
      };
    },
    moveTask: () => {
      taskProject = otherProject;
    },
    retireProject: () => {
      projectActive = false;
    },
  };
}

describe("task access through existing subject authority", () => {
  it("uses the actual typed ContextClient through this authenticated route and real host facts", async () => {
    const f = setup();
    const client = createContextClient({
      baseUrl: "http://127.0.0.1",
      windowCapability: capability,
      fetch: async (input, init) => {
        const answer = await f.dispatch(new Request(input, init));
        if (answer === undefined) throw new Error("Route unavailable");
        return answer;
      },
    });
    expect(await client.taskAccess?.(subject)).toMatchObject({
      selectedMode: "auto",
      effectiveMode: "plan",
      ceiling: "plan",
    });
  });
  it.each(["revoke", "expire", "rotate"] as const)(
    "refuses a cached local principal when its actual Request body finishes after %s",
    async (change) => {
      const f = setup();
      let write: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          write = controller;
        },
      });
      const init = {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": capability },
        body,
        duplex: "half" as const,
      };
      const result = f.dispatch(new Request("http://127.0.0.1/api/context/inspect", init));
      f[change]();
      write?.enqueue(new TextEncoder().encode(JSON.stringify({ subject, view: "task-access" })));
      write?.close();
      expect((await result)?.status).toBe(401);
      expect(f.privateRead).not.toHaveBeenCalled();
    },
  );

  it("serves the normal bound local read before any context plan", async () => {
    const f = setup();
    const answer = await f.dispatch();
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toMatchObject({
      kind: "task-access",
      selectedMode: "auto",
      effectiveMode: "plan",
    });
    expect(f.privateRead).toHaveBeenCalledTimes(1);
  });
  it("serves an authenticated remote read inside original CodeProjectAccess.run with no local workspace", async () => {
    const f = setup(true);
    const answer = await f.remoteDispatch();
    expect(answer?.status).toBe(200);
    expect(await answer?.json()).toMatchObject({ effectiveMode: "plan" });
    expect(f.privateRead).toHaveBeenCalledTimes(1);
  });
  it.each(["revoke", "expire", "rotate", "moveWindow", "moveTask", "retireProject"] as const)(
    "refuses a held bound-local read after %s without reading account facts",
    async (change) => {
      const f = setup();
      const release = Promise.withResolvers<void>();
      f.waitOn(release.promise);
      const answer = f.dispatch();
      await f.entered;
      f[change]();
      release.resolve();
      const result = await answer;
      expect(result?.status).not.toBe(200);
      expect(f.privateRead).not.toHaveBeenCalled();
    },
  );
  it("refuses a held authenticated remote read after its original request is aborted", async () => {
    const f = setup(true);
    const release = Promise.withResolvers<void>();
    f.waitOn(release.promise);
    const controller = new AbortController();
    const answer = f.remoteDispatch(controller.signal);
    await f.entered;
    controller.abort();
    release.resolve();
    expect((await answer)?.status).not.toBe(200);
    expect(f.privateRead).not.toHaveBeenCalled();
  });
});
