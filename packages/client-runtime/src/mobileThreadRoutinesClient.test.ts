import { describe, expect, it, vi } from "vitest";
import { loadMobileThreadRoutines } from "./mobileThreadRoutinesClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const THREAD = "20000000-0000-4000-8000-000000000001";
const OTHER_THREAD = "20000000-0000-4000-8000-000000000002";
const PROJECT = "20000000-0000-4000-8000-000000000010";
const NOW = "2026-11-11T12:00:00.000Z";

function summary(suffix: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `30000000-0000-4000-8000-0000000000${suffix}`,
    displayName: `Routine ${suffix}`,
    hostId: "local",
    mode: "work",
    projectId: PROJECT,
    lifecycle: "enabled",
    definitionRevision: 1,
    trigger: {
      kind: "weekly-local",
      weekdays: [1, 2, 3, 4, 5],
      localTime: "09:00",
      timeZone: "America/Los_Angeles",
    },
    nextDueAt: "2026-11-12T17:00:00.000Z",
    originThreadId: THREAD,
    version: 1,
    updatedAt: NOW,
    ...fields,
  };
}

function transportOf(pages: ReadonlyArray<unknown>, status = 200, unreachable = false) {
  const requests: Array<{ method: string; path: string; query?: string }> = [];
  let served = 0;
  const fetch = vi.fn(async (input: { method: string; path: string; query?: string }) => {
    requests.push(input);
    if (unreachable) throw new Error("offline");
    if (status !== 200) return new Response("{}", { status });
    return Response.json(pages[served++] ?? pages[pages.length - 1]);
  });
  const transport: MobileRemoteTransport = {
    hostId: "host-1",
    authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
  };
  return { transport, requests };
}

const thread = { threadId: THREAD, mode: "work" as const, projectId: PROJECT };

describe("reading a thread's routines over a paired session", () => {
  it("lists this thread's enabled and paused routines across pages, soonest first", async () => {
    const { transport, requests } = transportOf([
      {
        kind: "automation-list",
        items: [
          summary("01", { nextDueAt: "2026-11-14T17:00:00.000Z" }),
          summary("02", { originThreadId: OTHER_THREAD }),
          summary("03", { lifecycle: "archived" }),
        ],
        nextCursor: "page-2",
      },
      {
        kind: "automation-list",
        items: [
          summary("04", { lifecycle: "paused", nextDueAt: null }),
          summary("05", { nextDueAt: "2026-11-12T17:00:00.000Z" }),
        ],
      },
    ]);
    const result = await loadMobileThreadRoutines(transport, thread);
    if (result.status !== "loaded")
      throw new Error(`Expected a loaded list, got ${result.status}.`);
    const routines = result.routines;
    expect(routines.map((routine) => routine.name)).toEqual([
      "Routine 05",
      "Routine 01",
      "Routine 04",
    ]);
    expect(routines.find((routine) => routine.name === "Routine 04")).toMatchObject({
      paused: true,
      nextDueAt: null,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ method: "GET", path: "/api/automations/list" });
    expect(requests[0]?.query).toContain(`projectId=${PROJECT}`);
    expect(requests[0]?.query).toContain("mode=work");
    expect(requests[1]?.query).toContain("cursor=page-2");
  });

  it("leaves out a follow-up whose one run has started and keeps one still to come", async () => {
    const { transport } = transportOf([
      {
        kind: "automation-list",
        items: [
          summary("01", { targetPolicy: "same-thread", latestRunLifecycle: "completed" }),
          summary("02", { targetPolicy: "same-thread" }),
        ],
      },
    ]);
    const result = await loadMobileThreadRoutines(transport, thread);
    if (result.status !== "loaded")
      throw new Error(`Expected a loaded list, got ${result.status}.`);
    const routines = result.routines;
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({ name: "Routine 02", followUp: true });
  });

  it("says the host refused when it does not allow this device to read routines", async () => {
    const { transport } = transportOf([], 403);
    expect(await loadMobileThreadRoutines(transport, thread)).toEqual({ status: "refused" });
  });

  it("says the read failed, and why, instead of throwing", async () => {
    expect(await loadMobileThreadRoutines(transportOf([], 500).transport, thread)).toEqual({
      status: "failed",
      reason: "unavailable",
    });
    expect(await loadMobileThreadRoutines(transportOf([], 200, true).transport, thread)).toEqual({
      status: "failed",
      reason: "unreachable",
    });
    expect(
      await loadMobileThreadRoutines(transportOf([{ kind: "something-else" }]).transport, thread),
    ).toEqual({ status: "failed", reason: "invalid" });
  });

  it("says the list was cut short, and keeps what it read, when the Project has more pages than one read walks", async () => {
    const { transport, requests } = transportOf([
      { kind: "automation-list", items: [summary("01")], nextCursor: "more" },
    ]);
    const result = await loadMobileThreadRoutines(transport, thread);
    expect(result.status).toBe("truncated");
    if (result.status !== "truncated") return;
    expect(result.routines.length).toBeGreaterThan(0);
    // One read walks a bounded number of pages and then stops.
    expect(requests).toHaveLength(10);
  });
});
