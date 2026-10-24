import {
  decodePendingRequest,
  decodeProjectId,
  decodeWindowId,
  type PendingRequest,
  type ProductSurfaceSettings,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import type { DeviceId, RemoteSessionId, StableHostId } from "@octant/contracts/remote-access";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { contextKeyForProject, defaultShellSettings, defaultWindowWorkspace } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { createFleetActivityRouteHandler } from "./fleetActivityRoutes";
import {
  FleetActivityService,
  type FleetActivitySources,
  type FleetRunningThread,
  windowsBoundToACodeProject,
  windowsBoundToAProject,
} from "./fleetActivityService";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const codeThread = "00000000-0000-4000-8000-000000000904";

const codeApproval = decodePendingRequest({
  mode: "code",
  kind: "approval",
  projectId,
  threadId: codeThread,
  threadTitle: "Fix the parser",
  text: "Allow `bun test`?",
  requestedAt: "2026-10-06T08:01:00.000Z",
  answer: {
    threadId: codeThread,
    checkoutId: "00000000-0000-4000-8000-000000000905",
    approvalId: "00000000-0000-4000-8000-000000000906",
  },
});
const workApproval = decodePendingRequest({
  mode: "work",
  kind: "approval",
  projectId,
  threadId: "00000000-0000-4000-8000-000000000902",
  threadTitle: "Quarterly report",
  text: "Run `bun install`.",
  requestedAt: "2026-10-06T08:00:00.000Z",
  answer: { requestId: "00000000-0000-4000-8000-000000000903", expectedVersion: 1 },
});

const workThread = "00000000-0000-4000-8000-000000000902";
const childRun = "00000000-0000-4000-8000-000000000a01";
const waitingChild = (kind: "child-approval" | "child-question", requestedAt: string) =>
  decodePendingRequest({
    mode: "work",
    kind,
    projectId,
    threadId: workThread,
    threadTitle: "Quarterly report",
    child: { runId: childRun, role: "research", task: "Collect the figures." },
    text: kind === "child-approval" ? "Run `bun install`." : "Which quarter?",
    requestedAt,
  });

describe("fleet activity route", () => {
  it("lists a parent thread with waiting subagents as one needs-you row read from the session", async () => {
    const { route } = fixture({
      pending: [
        waitingChild("child-approval", "2026-10-06T08:02:00.000Z"),
        waitingChild("child-question", "2026-10-06T08:03:00.000Z"),
      ],
    });
    expect((await (await route(request()))?.json()).threads).toEqual([
      {
        mode: "work",
        threadId: workThread,
        title: "Quarterly report",
        projectName: "Reports",
        state: "needs-you",
        activitySource: "session",
        since: "2026-10-06T08:02:00.000Z",
      },
    ]);
  });

  it("lists a thread whose agent waits on its own approval as one needs-you row read from the session, never the request text", async () => {
    const { route } = fixture({
      pending: [
        decodePendingRequest({
          mode: "work",
          kind: "lead-approval",
          projectId,
          threadId: workThread,
          threadTitle: "Quarterly report",
          text: "edit: summary.md",
          requestedAt: "2026-10-06T08:02:00.000Z",
        }),
      ],
    });
    const body = await (await route(request()))?.json();
    expect(body.threads).toEqual([
      {
        mode: "work",
        threadId: workThread,
        title: "Quarterly report",
        projectName: "Reports",
        state: "needs-you",
        activitySource: "session",
        since: "2026-10-06T08:02:00.000Z",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("summary.md");
  });

  it("lists needs-you before working, naming where each state was read", async () => {
    const { route } = fixture({
      chat: [{ threadId: "chat-1", title: "Trip plan", turnStartedAt: "2026-10-06T08:05:00.000Z" }],
      code: [
        // A held turn still runs while it waits on the approval: listed once, as needs-you.
        { threadId: codeThread, title: "Fix the parser", projectId },
        {
          threadId: "00000000-0000-4000-8000-000000000910",
          title: "Ship it",
          projectId,
          turnStartedAt: "2026-10-06T08:02:00.000Z",
        },
      ],
    });
    const response = await route(request());
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      threads: [
        {
          mode: "work",
          threadId: "00000000-0000-4000-8000-000000000902",
          title: "Quarterly report",
          projectName: "Reports",
          state: "needs-you",
          activitySource: "journal",
          since: "2026-10-06T08:00:00.000Z",
        },
        {
          mode: "code",
          threadId: codeThread,
          title: "Fix the parser",
          projectName: "Reports",
          state: "needs-you",
          activitySource: "session",
          since: "2026-10-06T08:01:00.000Z",
        },
        {
          mode: "code",
          threadId: "00000000-0000-4000-8000-000000000910",
          title: "Ship it",
          projectName: "Reports",
          state: "working",
          activitySource: "journal",
          since: "2026-10-06T08:02:00.000Z",
        },
        {
          mode: "chat",
          threadId: "chat-1",
          title: "Trip plan",
          state: "working",
          activitySource: "journal",
          since: "2026-10-06T08:05:00.000Z",
        },
      ],
      truncated: false,
    });
  });

  it("lists a waiting subagent a bound window could open when the menu bar's own read has none", async () => {
    const boundWindow = decodeWindowId("00000000-0000-4000-8000-000000000802");
    const otherWindow = decodeWindowId("00000000-0000-4000-8000-000000000803");
    const child = decodePendingRequest({
      mode: "code",
      kind: "child-approval",
      projectId,
      threadId: codeThread,
      threadTitle: "Fix the parser",
      child: { runId: childRun, role: "implementation", task: "Check the grammar." },
      text: "Allow `bun test`?",
      requestedAt: "2026-10-06T08:04:00.000Z",
    });
    const { route, sources } = fixture({
      pending: [],
      boundProjectWindows: [boundWindow, otherWindow],
      childPending: async () => [child],
    });
    const body = await (await route(request()))?.json();
    expect(body.threads).toEqual([
      {
        mode: "code",
        threadId: codeThread,
        title: "Fix the parser",
        projectName: "Reports",
        state: "needs-you",
        activitySource: "session",
        since: "2026-10-06T08:04:00.000Z",
      },
    ]);
    expect(sources.pending).toHaveBeenCalledExactlyOnceWith(windowId);
    expect(sources.childPending).toHaveBeenNthCalledWith(1, boundWindow);
    expect(sources.childPending).toHaveBeenNthCalledWith(2, otherWindow);
    expect(sources.codePending).not.toHaveBeenCalled();
  });

  it("asks for a waiting subagent in every saved window bound to a Project, open or not, and in none bound to no Project, once per binding", () => {
    const unbound = decodeWindowId("00000000-0000-4000-8000-000000000811");
    const codeBound = decodeWindowId("00000000-0000-4000-8000-000000000812");
    const workBound = decodeWindowId("00000000-0000-4000-8000-000000000813");
    const codeBoundAgain = decodeWindowId("00000000-0000-4000-8000-000000000814");
    const bind = (window: WindowId, mode: "code" | "work") => {
      const empty = defaultWindowWorkspace(window);
      return {
        workspace: {
          ...empty,
          contextByMode: {
            ...empty.contextByMode,
            [mode]: contextKeyForProject(mode, LOCAL_HOST_ID, projectId, "/repo"),
          },
        },
      };
    };
    expect(
      windowsBoundToAProject([
        { workspace: defaultWindowWorkspace(unbound) },
        bind(codeBound, "code"),
        bind(workBound, "work"),
        bind(codeBoundAgain, "code"),
      ]),
    ).toEqual([codeBound, workBound]);
    expect(windowsBoundToAProject([{ workspace: defaultWindowWorkspace(unbound) }])).toEqual([]);
  });

  it("asks for a Code request once per bound Code Project, not once per saved window", () => {
    const first = decodeWindowId("00000000-0000-4000-8000-000000000821");
    const sameProject = decodeWindowId("00000000-0000-4000-8000-000000000822");
    const otherProject = decodeWindowId("00000000-0000-4000-8000-000000000823");
    const workOnly = decodeWindowId("00000000-0000-4000-8000-000000000824");
    const otherProjectId = decodeProjectId("00000000-0000-4000-8000-000000000911");
    const bind = (window: WindowId, mode: "code" | "work", project: ProjectId = projectId) => {
      const empty = defaultWindowWorkspace(window);
      return {
        workspace: {
          ...empty,
          contextByMode: {
            ...empty.contextByMode,
            [mode]: contextKeyForProject(mode, LOCAL_HOST_ID, project, "/repo"),
          },
        },
      };
    };
    expect(
      windowsBoundToACodeProject([
        bind(first, "code"),
        bind(sameProject, "code"),
        bind(otherProject, "code", otherProjectId),
        bind(workOnly, "work"),
      ]),
    ).toEqual([first, otherProject]);
  });

  it("leaves a waiting subagent out of the menu bar when its mode is off", async () => {
    const boundWindow = decodeWindowId("00000000-0000-4000-8000-000000000802");
    const { route } = fixture({
      settings: { ...defaultShellSettings(), workEnabled: false },
      pending: [],
      boundProjectWindows: [boundWindow],
      childPending: async () => [waitingChild("child-approval", "2026-10-06T08:02:00.000Z")],
    });
    const body = await (await route(request()))?.json();
    expect(body.threads).toEqual([]);
  });

  it("lists a Code request a bound local window could answer, and none from a Project no window binds", async () => {
    const boundWindow = decodeWindowId("00000000-0000-4000-8000-000000000802");
    const { route, sources } = fixture({
      pending: [],
      boundCodeWindows: [boundWindow],
      codePending: async (scope) => (String(scope) === String(boundWindow) ? [codeApproval] : []),
    });
    const body = await (await route(request()))?.json();
    expect(body.threads).toEqual([
      expect.objectContaining({
        mode: "code",
        threadId: codeThread,
        state: "needs-you",
        activitySource: "session",
      }),
    ]);
    // Code reach is per bound window; the menu bar's own unbound window is never asked for it.
    expect(sources.codePending).toHaveBeenCalledExactlyOnceWith(boundWindow);
  });

  it("asks a disabled mode for nothing", async () => {
    const { route, sources } = fixture({
      settings: { ...defaultShellSettings(), chatEnabled: false, workEnabled: false },
      chat: [{ threadId: "chat-1", title: "Trip plan" }],
    });
    const body = await (await route(request()))?.json();
    expect(body.threads.map((thread: { mode: string }) => thread.mode)).not.toContain("chat");
    expect(sources.work).not.toHaveBeenCalled();
    expect(sources.chat).not.toHaveBeenCalled();
  });

  it("refuses a read without the window capability", async () => {
    const { route, sources } = fixture();
    const response = await route(new Request("http://127.0.0.1/api/fleet-activity"));
    expect(response?.status).toBe(401);
    expect(sources.pending).not.toHaveBeenCalled();
  });

  it("refuses a paired device even when its request reaches the route", async () => {
    const { route, sources } = fixture();
    const remote = new Request("http://127.0.0.1/api/fleet-activity");
    bindPrincipalRouteContext(remote, {
      principal: createRemoteDevicePrincipal({
        hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
        deviceId: "22222222-2222-4222-8222-222222222222" as DeviceId,
        credentialGeneration: 1,
        origin: "https://octant.example",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
      }),
      scopeId: decodeWindowId("22222222-2222-4222-8222-222222222222"),
    });
    const response = await route(remote);
    expect(response?.status).toBe(403);
    expect(JSON.stringify(await response?.json())).not.toContain("Quarterly report");
    expect(sources.pending).not.toHaveBeenCalled();
  });

  it("refuses a read that is not on loopback or that names a parameter", async () => {
    const { route } = fixture();
    const remoteHost = await route(
      new Request("http://192.168.1.20/api/fleet-activity", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(remoteHost?.status).toBe(400);
    expect((await route(request(`?windowId=${String(windowId)}`)))?.status).toBe(400);
  });

  it("fails the read rather than leave out a mode it could not read", async () => {
    const { route } = fixture({
      code: async () => {
        throw new Error("checkout authority unavailable");
      },
    });
    const response = await route(request());
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      code: "unavailable",
      message: "Fleet states are unavailable.",
    });
  });
});

function request(search = ""): Request {
  return new Request(`http://127.0.0.1/api/fleet-activity${search}`, {
    headers: { "x-octant-window-capability": capability },
  });
}

function fixture(
  options: {
    readonly settings?: ProductSurfaceSettings;
    readonly pending?: ReadonlyArray<PendingRequest>;
    readonly chat?: ReadonlyArray<FleetRunningThread>;
    readonly code?:
      | ReadonlyArray<FleetRunningThread>
      | (() => Promise<ReadonlyArray<FleetRunningThread>>);
    readonly boundCodeWindows?: ReadonlyArray<WindowId>;
    readonly codePending?: (windowId: WindowId) => Promise<ReadonlyArray<PendingRequest>>;
    readonly boundProjectWindows?: ReadonlyArray<WindowId>;
    readonly childPending?: (windowId: WindowId) => Promise<ReadonlyArray<PendingRequest>>;
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const code = options.code;
  const sources = {
    readSettings: () => options.settings ?? defaultShellSettings(),
    pending: vi.fn(async () => ({
      requests: [...(options.pending ?? [workApproval, codeApproval])],
      truncated: false,
    })),
    chat: vi.fn(() => options.chat ?? []),
    work: vi.fn(async () => []),
    code: vi.fn(typeof code === "function" ? code : async () => code ?? []),
    boundCodeWindows: () => options.boundCodeWindows ?? [],
    codePending: vi.fn(options.codePending ?? (async () => [])),
    boundProjectWindows: () => options.boundProjectWindows ?? [],
    childPending: vi.fn(options.childPending ?? (async () => [])),
    projectName: (id) => (String(id) === String(projectId) ? "Reports" : undefined),
  } satisfies FleetActivitySources;
  const route = createFleetActivityRouteHandler({
    service: new FleetActivityService(sources),
    windowAuthorityStore: store,
    now: () => 1,
  });
  return { route, sources };
}
