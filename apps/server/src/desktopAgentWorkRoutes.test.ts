import { describe, expect, it } from "vitest";
import {
  decodeDesktopAgentWorkSnapshot,
  decodeUtcTimestamp,
  type KeepAwakePolicy,
} from "@octant/contracts";
import {
  createDesktopAgentWorkRouteHandler,
  DESKTOP_AGENT_WORK_ROUTE,
  type DesktopAgentWorkRoutineSchedule,
} from "./desktopAgentWorkRoutes";
import { LiveTurnRegistry } from "./liveTurn/liveTurnRegistry";
import { bindPrincipalRouteContext } from "./principalRouteContext";

const SECRET = "desktop-bridge-secret";
const NOW = new Date("2026-11-19T20:25:00.000Z");

function makeRequest(options: {
  readonly origin?: string;
  readonly host?: string;
  readonly method?: string;
  readonly search?: string;
  readonly secret?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly remotePrincipal?: boolean;
}): Request {
  const host = options.host ?? "http://127.0.0.1:4567";
  const headers: Record<string, string> = {
    ...(options.secret === undefined ? {} : { "x-octant-desktop-secret": options.secret }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...options.extraHeaders,
  };
  const request = new Request(`${host}${DESKTOP_AGENT_WORK_ROUTE}${options.search ?? ""}`, {
    method: options.method ?? "GET",
    headers,
  });
  if (options.remotePrincipal === true) {
    bindPrincipalRouteContext(request, {
      principal: {
        kind: "remote-device",
        hostId: "11111111-1111-4111-8111-111111111111",
        deviceId: "55000000-0000-4000-8000-000000000001",
        credentialGeneration: 1,
        origin: "https://remote.example",
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: "55000000-0000-4000-8000-0000000000aa",
        admittedBy: "host-person",
      } as never,
      scopeId: "55000000-0000-4000-8000-000000000001" as never,
    });
  }
  return request;
}

describe("GET /api/desktop/agent-work", () => {
  it("refuses unauthenticated, remote, browser, non-loopback, and non-desktop callers", async () => {
    const handle = createDesktopAgentWorkRouteHandler({
      desktopBridgeSecret: SECRET,
      keepAwakePolicy: () => "on-power",
      activeTurns: () => [],
      isCoordinatorWorker: () => false,
      runningChildRuns: () => 0,
      routines: () => [],
      now: () => NOW,
    });

    expect((await handle(makeRequest({})))?.status).toBe(401);
    expect((await handle(makeRequest({ secret: "wrong" })))?.status).toBe(401);
    expect(
      (await handle(makeRequest({ secret: SECRET, origin: "http://127.0.0.1:4567" })))?.status,
    ).toBe(401);
    expect(
      (await handle(makeRequest({ secret: SECRET, host: "http://192.168.1.20:4567" })))?.status,
    ).toBe(401);
    expect((await handle(makeRequest({ secret: SECRET, remotePrincipal: true })))?.status).toBe(
      401,
    );
    expect(
      (
        await handle(
          makeRequest({
            extraHeaders: {
              "x-octant-window-capability": "window-cap",
              "x-octant-native-main-authority": "nightly-token",
            },
          }),
        )
      )?.status,
    ).toBe(401);
    expect((await handle(makeRequest({ secret: SECRET, method: "POST" })))?.status).toBe(405);
    expect((await handle(makeRequest({ secret: SECRET, search: "?foo=1" })))?.status).toBe(400);
    expect(await handle(new Request("http://127.0.0.1:4567/api/other"))).toBeUndefined();
  });

  it("reports running Chat, Work, and Code turns, child runs, coordinator workers, and earliest routine due time, and drops counts when work ends", async () => {
    const liveTurns = new LiveTurnRegistry();
    const coordinatorWorkerIds = new Set<string>(["code-worker-1"]);
    let childRuns = 2;
    let keepAwake: KeepAwakePolicy = "on-power";
    let routines: ReadonlyArray<DesktopAgentWorkRoutineSchedule> = [
      { enabled: false, nextDueAt: decodeUtcTimestamp("2026-11-19T20:26:00.000Z") },
      { enabled: true, nextDueAt: decodeUtcTimestamp("2026-11-19T20:40:00.000Z") },
      { enabled: true, nextDueAt: decodeUtcTimestamp("2026-11-19T20:28:00.000Z") },
      { enabled: true, nextDueAt: null },
    ];

    const chatTurn = liveTurns.tracker("chat-thread-1", "chat-navigation");
    const workTurn = liveTurns.tracker("work-thread-1", "work-navigation");
    const codeTurn = liveTurns.tracker("code-thread-1", "code-navigation");
    const workerTurn = liveTurns.tracker("code-worker-1", "code-navigation");
    chatTurn.begin(NOW.toISOString());
    workTurn.begin(NOW.toISOString());
    codeTurn.begin(NOW.toISOString());
    workerTurn.begin(NOW.toISOString());

    const handle = createDesktopAgentWorkRouteHandler({
      desktopBridgeSecret: SECRET,
      keepAwakePolicy: () => keepAwake,
      activeTurns: () => liveTurns.activeEntries(),
      isCoordinatorWorker: (threadId) => coordinatorWorkerIds.has(threadId),
      runningChildRuns: () => childRuns,
      routines: () => routines,
      now: () => NOW,
    });

    const first = await handle(makeRequest({ secret: SECRET }));
    expect(first?.status).toBe(200);
    expect(first?.headers.get("cache-control")).toBe("no-store");
    const body = decodeDesktopAgentWorkSnapshot(await first?.json());
    expect(body).toEqual({
      keepAwake: "on-power",
      turns: { chat: 1, work: 1, code: 1 },
      childRuns: 2,
      coordinatorWorkers: 1,
      nextRoutineDueAt: "2026-11-19T20:28:00.000Z",
      observedAt: "2026-11-19T20:25:00.000Z",
    });

    // Counts drop to zero as work finishes and reflect updated policy and routine schedule.
    chatTurn.end();
    workTurn.end();
    codeTurn.end();
    workerTurn.end();
    childRuns = 0;
    keepAwake = "always";
    routines = [{ enabled: false, nextDueAt: decodeUtcTimestamp("2026-11-19T20:26:00.000Z") }];

    const second = await handle(makeRequest({ secret: SECRET }));
    expect(second?.status).toBe(200);
    expect(decodeDesktopAgentWorkSnapshot(await second?.json())).toEqual({
      keepAwake: "always",
      turns: { chat: 0, work: 0, code: 0 },
      childRuns: 0,
      coordinatorWorkers: 0,
      nextRoutineDueAt: null,
      observedAt: "2026-11-19T20:25:00.000Z",
    });
  });
});
