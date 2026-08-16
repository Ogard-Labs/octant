import { describe, expect, it, vi } from "vitest";
import {
  decodeWorkMutationReply,
  decodeWorkMutationRequestId,
  decodeProjectId,
  type WorkMutationReply,
  type WorkMutationRequest,
} from "@octant/contracts";
import { WorkMutationClientFailure, createWorkMutationClient } from "./workMutationClient";

const projectId = decodeProjectId("20000000-0000-4000-8000-000000000011");
const requestId = decodeWorkMutationRequestId("20000000-0000-4000-8000-000000000012");
const baseUrl = "http://127.0.0.1:4317";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("createWorkMutationClient", () => {
  it("posts Work mutation requests to the authenticated route", async () => {
    const reply = successReply();
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createWorkMutationClient({
      baseUrl,
      fetch,
      windowCapability: capability,
    });

    await expect(client.mutate(validRequest())).resolves.toEqual(reply);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/work/mutations`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        }),
        body: JSON.stringify(validRequest()),
      }),
    );
  });

  it("maps typed HTTP failures", async () => {
    const client = createWorkMutationClient({
      baseUrl,
      fetch: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ message: "forbidden" }), { status: 404 })),
      windowCapability: capability,
    });

    await expect(client.mutate(validRequest())).rejects.toMatchObject({
      name: "WorkMutationClientFailure",
      status: 404,
      message: "forbidden",
    } satisfies Partial<WorkMutationClientFailure>);
  });

  it("survives Electron replacing globalThis.fetch after client construction", async () => {
    const original = globalThis.fetch;
    const stale = vi.fn().mockRejectedValue(new TypeError("stale realm fetch"));
    const live = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successReply()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = stale;
    const client = createWorkMutationClient({
      baseUrl,
      fetch: globalThis.fetch,
      windowCapability: capability,
    });
    globalThis.fetch = live;

    const reply = await client.mutate(validRequest());
    expect(reply.outcome.kind).toBe("created");
    expect(live).toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
    globalThis.fetch = original;
  });
});

function validRequest(): WorkMutationRequest {
  return {
    kind: "create-artifact",
    requestId,
    projectId,
    format: "docx",
    displayName: "Brief.docx",
    content: "# Brief\nHello world",
  };
}

function successReply(): WorkMutationReply {
  return decodeWorkMutationReply({
    requestId,
    outcome: {
      kind: "created",
      artifact: {
        artifactId: "20000000-0000-4000-8000-000000000013",
        projectId,
        format: "docx",
        artifactRef: "artifact-token-1",
        displayName: "Brief.docx",
        createdAt: "2026-07-26T20:00:00.000Z",
      },
      version: {
        versionId: "20000000-0000-4000-8000-000000000014",
        artifactId: "20000000-0000-4000-8000-000000000013",
        projectId,
        format: "docx",
        sourceVersion: {
          contentSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          byteSize: 0,
          observedAt: "2026-07-26T20:00:00.000Z",
        },
        createdBy: { kind: "local-user", actorId: "20000000-0000-4000-8000-000000000015" },
        createdAt: "2026-07-26T20:00:00.000Z",
        sequence: 1,
      },
      previewTarget: {
        targetId: "20000000-0000-4000-8000-000000000016",
        projectId,
        hostId: "20000000-0000-4000-8000-000000000017",
        kind: "artifact-version",
        opaqueRef: "artifact-token-1",
        displayName: "Brief.docx",
      },
    },
    capability: {
      format: "docx",
      capabilities: {
        canRead: true,
        canCreate: true,
        canMutate: true,
        canRoundTrip: true,
        canExport: true,
        canVersion: true,
      },
      fidelity: { level: "limited", notice: "DOCX round-trips may lose formatting details." },
      exportFormats: ["markdown"],
    },
  });
}
