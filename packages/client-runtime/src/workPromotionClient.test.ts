import {
  decodeWorkPromotionProposalId,
  decodeWorkPromotionProposal,
  decodeProjectId,
  type WorkPromotionCommandResult,
  type WorkPromotionList,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WorkPromotionClientFailure, createWorkPromotionClient } from "./workPromotionClient";

const baseUrl = "http://127.0.0.1:13773";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const originProjectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const proposalId = decodeWorkPromotionProposalId("00000000-0000-4000-8000-000000000902");

const listFixture: WorkPromotionList = {
  proposals: [
    decodeWorkPromotionProposal({
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
    }),
  ],
  artifactRefs: [],
  deliveryTargets: [],
};

describe("createWorkPromotionClient", () => {
  it("lists proposals for the authenticated window", async () => {
    const fetch = vi.fn(async () =>
      Response.json(listFixture, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createWorkPromotionClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.list(originProjectId)).resolves.toEqual(listFixture);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/work/promotions?originProjectId=${encodeURIComponent(String(originProjectId))}`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-octant-window-capability": capability,
        }),
      }),
    );
  });

  it("executes promotion commands", async () => {
    const result: WorkPromotionCommandResult = {
      kind: "work-promotion-proposed",
      proposal: listFixture.proposals[0]!,
    };
    const fetch = vi.fn(async () =>
      Response.json(result, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = createWorkPromotionClient({ baseUrl, fetch, windowCapability: capability });
    const command = {
      kind: "propose-work-promotion" as const,
      proposalId,
      originProjectId,
      targetCodeProjectId: listFixture.proposals[0]!.targetCodeProjectId,
      selectedContext: listFixture.proposals[0]!.selectedContext,
      proposedCodePermissionPersistence: "current-session" as const,
    };
    await expect(client.execute(command)).resolves.toEqual(result);
  });

  it("maps typed promotion failures", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { code: "unauthorized", message: "Promotion authority denied." },
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createWorkPromotionClient({ baseUrl, fetch, windowCapability: capability });
    await expect(
      client.execute({
        kind: "dismiss-work-promotion",
        proposalId,
        expectedVersion: listFixture.proposals[0]!.version,
      }),
    ).rejects.toMatchObject({
      name: "WorkPromotionClientFailure",
      code: "unauthorized",
    } satisfies Partial<WorkPromotionClientFailure>);
  });
});
