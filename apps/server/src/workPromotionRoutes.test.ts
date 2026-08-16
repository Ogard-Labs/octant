import {
  decodeWorkPromotionProposal,
  decodeWorkPromotionProposalId,
  decodeProjectId,
  decodeWindowId,
  type WorkPromotionCommandResult,
  type WorkPromotionList,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createWorkPromotionRouteHandler } from "./workPromotionRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const originProjectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const proposalId = decodeWorkPromotionProposalId("00000000-0000-4000-8000-000000000902");

const proposedProposal = decodeWorkPromotionProposal({
  proposalId,
  originProjectId,
  targetCodeProjectId: decodeProjectId("00000000-0000-4000-8000-000000000903"),
  selectedContext: {
    summary: "Promote the report generator into a CLI",
    artifactRefs: ["artifact-token-a"],
  },
  status: "proposed",
  proposedCodeExecutionPolicy: "approval-gated",
  proposedCodePermissionPersistence: "current-session",
  proposedBy: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" },
  proposedAt: "2026-07-22T08:00:00.000Z",
  version: 1,
});

describe("Work promotion routes", () => {
  it("rejects missing window capability on list", async () => {
    const route = routeFixture();
    const response = await route(new Request("http://127.0.0.1/api/work/promotions"));
    expect(response?.status).toBe(401);
  });

  it("lists proposals for an authenticated window", async () => {
    const list = vi.fn(
      async (): Promise<WorkPromotionList> => ({
        proposals: [proposedProposal],
        artifactRefs: [],
        deliveryTargets: [],
      }),
    );
    const route = routeFixture({ list });
    const response = await route(request("/api/work/promotions"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      proposals: [proposedProposal],
      artifactRefs: [],
      deliveryTargets: [],
    });
    expect(list).toHaveBeenCalledWith(windowId, undefined);
  });

  it("filters list requests by originProjectId", async () => {
    const list = vi.fn(
      async (): Promise<WorkPromotionList> => ({
        proposals: [proposedProposal],
        artifactRefs: [],
        deliveryTargets: [],
      }),
    );
    const route = routeFixture({ list });
    await route(
      request(
        `/api/work/promotions?originProjectId=${encodeURIComponent(String(originProjectId))}`,
      ),
    );
    expect(list).toHaveBeenCalledWith(windowId, originProjectId);
  });

  it("executes promotion commands for an authenticated window", async () => {
    const execute = vi.fn(
      async (): Promise<WorkPromotionCommandResult> => ({
        kind: "work-promotion-proposed",
        proposal: proposedProposal,
      }),
    );
    const route = routeFixture({ execute });
    const command = {
      kind: "propose-work-promotion",
      proposalId,
      originProjectId,
      targetCodeProjectId: proposedProposal.targetCodeProjectId,
      selectedContext: proposedProposal.selectedContext,
      proposedCodePermissionPersistence: "current-session",
    };
    const response = await route(
      request("/api/work/promotions/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      kind: "work-promotion-proposed",
      proposal: proposedProposal,
    });
    expect(execute).toHaveBeenCalledWith(windowId, command);
  });

  it("maps promotion failures to typed HTTP responses", async () => {
    const execute = vi.fn(async () => {
      throw promotionFailure("unauthorized", "Promotion authority denied.");
    });
    const route = routeFixture({ execute });
    const response = await route(
      request("/api/work/promotions/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "dismiss-work-promotion",
          proposalId,
          expectedVersion: 1,
        }),
      }),
    );
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({
      code: "unauthorized",
      message: "Promotion authority denied.",
    });
  });

  it("never exposes canonical roots or binding receipts in list responses", async () => {
    const route = routeFixture({
      list: async () => ({ proposals: [proposedProposal], artifactRefs: [], deliveryTargets: [] }),
    });
    const body = JSON.stringify(await (await route(request("/api/work/promotions")))?.json());
    expect(body).not.toMatch(/canonicalRoot|bindingReceipt|file:|\\\\/);
  });
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("x-octant-window-capability")) {
    headers.set("x-octant-window-capability", capability);
  }
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

function routeFixture(overrides: Record<string, unknown> = {}) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const service = {
    list: vi.fn(async () => ({ proposals: [], artifactRefs: [], deliveryTargets: [] })),
    execute: vi.fn(async () => ({
      kind: "work-promotion-dismissed",
      proposal: {
        ...proposedProposal,
        status: "dismissed",
        decidedAt: "2026-07-22T08:05:00.000Z",
        version: 2,
      },
    })),
    ...overrides,
  };
  return createWorkPromotionRouteHandler({
    service: service as never,
    windowAuthorityStore: store,
    now: () => 1,
  });
}

function promotionFailure(code: "unauthorized", message: string): Error & { failure: unknown } {
  const error = new Error(message) as Error & { failure: unknown };
  error.failure = { code, message };
  return error;
}
