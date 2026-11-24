import { describe, expect, it, vi } from "vitest";
import {
  decideMobileMemoryProposal,
  decideMobileRoutineProposal,
  listMobileMemoryProposals,
  listMobileRoutineProposals,
} from "./mobileAgentProposalClient";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const threadId = "67000000-0000-4000-8000-000000000001";
const otherThreadId = "67000000-0000-4000-8000-000000000002";
const projectId = "67000000-0000-4000-8000-0000000000aa";

function memoryProposal(proposalId: string, thread: string) {
  return {
    proposalId,
    projectId,
    mode: "work",
    threadId: thread,
    change: { kind: "create", memoryKind: "fact", content: "The build runs on Bun." },
    expectedVersion: 3,
    requestedAt: "2026-11-20T09:00:00.000Z",
  };
}

function routineProposal(proposalId: string, thread: string) {
  return {
    proposalId,
    threadId: thread,
    mode: "work",
    projectId,
    displayName: "Morning triage",
    taskPrompt: "Triage new issues.",
    trigger: { kind: "interval", intervalMinutes: 60, anchorAt: "2026-11-20T09:00:00.000Z" },
    missedRunPolicy: "skip",
    firstRunAt: "2026-11-20T10:00:00.000Z",
    requestedAt: "2026-11-20T09:00:00.000Z",
  };
}

function transportAnswering(answer: (input: { path: string; method: string }) => Response) {
  const fetch = vi.fn(async (input: { path: string; method: string; body?: unknown }) =>
    answer(input),
  );
  const transport: MobileRemoteTransport = {
    hostId: "67000000-0000-4000-8000-0000000000ff",
    authenticatedFetch: fetch as MobileRemoteTransport["authenticatedFetch"],
  };
  return { transport, fetch };
}

describe("Project memory and routine proposals on a paired device", () => {
  it("lists only the open thread's memory proposals and answers on the host's memory decision route", async () => {
    const { transport, fetch } = transportAnswering(({ method }) =>
      method === "GET"
        ? Response.json({
            kind: "project-memory-proposal-list",
            proposals: [
              memoryProposal("67000000-0000-4000-8000-000000000010", threadId),
              memoryProposal("67000000-0000-4000-8000-000000000011", otherThreadId),
            ],
          })
        : Response.json({ kind: "project-memory-proposal-declined" }),
    );

    const listed = await listMobileMemoryProposals({ transport, threadId });
    expect(listed.map((entry) => String(entry.proposalId))).toEqual([
      "67000000-0000-4000-8000-000000000010",
    ]);
    await expect(
      decideMobileMemoryProposal({
        transport,
        proposalId: "67000000-0000-4000-8000-000000000010",
        decision: "decline",
      }),
    ).resolves.toEqual({ status: "answered" });
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/api/projects/memory/proposals",
    });
    expect(fetch.mock.calls[1]?.[0]).toMatchObject({
      method: "POST",
      path: "/api/projects/memory/proposals/decide",
      contentType: "application/json",
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[0].body))).toEqual({
      proposalId: "67000000-0000-4000-8000-000000000010",
      decision: "decline",
    });
  });

  it("says when a confirmed memory change was not applied or the proposal had already gone", async () => {
    const answers = [
      Response.json({ kind: "project-memory-proposal-not-applied", message: "Memory moved on." }),
      Response.json({ kind: "project-memory-proposal-gone" }),
      new Response(null, { status: 403 }),
    ];
    const { transport } = transportAnswering(() => answers.shift() ?? Response.error());
    const decide = () =>
      decideMobileMemoryProposal({
        transport,
        proposalId: "67000000-0000-4000-8000-000000000010",
        decision: "confirm",
      });
    await expect(decide()).resolves.toEqual({
      status: "not-applied",
      message: "Memory moved on.",
    });
    await expect(decide()).resolves.toEqual({ status: "gone" });
    await expect(decide()).resolves.toEqual({ status: "refused" });
  });

  it("lists only the open thread's routine requests and answers on the host's routine decision route", async () => {
    const { transport, fetch } = transportAnswering(({ method }) =>
      method === "GET"
        ? Response.json({
            kind: "routine-proposal-list",
            proposals: [
              routineProposal("67000000-0000-4000-8000-000000000020", otherThreadId),
              routineProposal("67000000-0000-4000-8000-000000000021", threadId),
            ],
          })
        : Response.json({
            kind: "automation-command-failed",
            reason: "stale-version",
            message: "The routine changed since the agent asked.",
          }),
    );

    const listed = await listMobileRoutineProposals({ transport, threadId });
    expect(listed.map((entry) => String(entry.proposalId))).toEqual([
      "67000000-0000-4000-8000-000000000021",
    ]);
    await expect(
      decideMobileRoutineProposal({
        transport,
        proposalId: "67000000-0000-4000-8000-000000000021",
        decision: "confirm",
      }),
    ).resolves.toEqual({
      status: "not-applied",
      message: "The routine changed since the agent asked.",
    });
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/api/automations/proposals",
    });
    expect(fetch.mock.calls[1]?.[0]).toMatchObject({
      method: "POST",
      path: "/api/automations/proposals/decide",
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[0].body))).toEqual({
      proposalId: "67000000-0000-4000-8000-000000000021",
      decision: "confirm",
    });
  });

  it("throws on a refused read so a caller keeps what it last showed", async () => {
    const { transport } = transportAnswering(() => new Response(null, { status: 503 }));
    await expect(listMobileRoutineProposals({ transport, threadId })).rejects.toThrow();
    await expect(listMobileMemoryProposals({ transport, threadId })).rejects.toThrow();
  });
});
