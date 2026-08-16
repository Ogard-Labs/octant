import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { decodeProjectId, decodeWindowId, type WorkMutationRequest } from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";
import { decodePreviewHostId } from "@octant/contracts/previews";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createWorkMutationRouteHandler } from "./workMutationRoutes";
import { WorkArtifactProjection } from "./work/workArtifactProjection";
import type { WorkFilesystemPort } from "./work/workFilesystemPort";
import { workFilesystemFixture } from "./work/workFilesystemFixture";
import { WorkMutationService } from "./work/workMutationService";
import { WorkResolutionService } from "./work/workResolutionService";
import "./work/workFormatAdapters";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000811");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000812");
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "00000000-0000-4000-8000-000000000813",
});

describe("Work mutation routes", () => {
  it("requires window capability authentication", async () => {
    const route = createRoute();
    const response = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validCreateRequest()),
      }),
    );

    expect(response?.status).toBe(401);
  });

  it("rejects requests that try to supply window identity", async () => {
    const route = createRoute();
    const response = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({ ...validCreateRequest(), windowId }),
      }),
    );

    expect(response?.status).toBe(400);
  });

  it("rejects non-loopback requests", async () => {
    const route = createRoute();
    const response = await route(
      new Request("http://example.com/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(validCreateRequest()),
      }),
    );

    expect(response?.status).toBe(400);
  });

  it.each([
    { name: "an inaccessible Project", accessible: false, projectType: "work" as const },
    { name: "a non-Work Project", accessible: true, projectType: "code" as const },
  ])("returns 404 for $name", async ({ accessible, projectType }) => {
    const route = createRoute({ accessible, projectType });
    const response = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(validCreateRequest()),
      }),
    );

    expect(response?.status).toBe(404);
  });

  it("creates a Work artifact for an accessible Work Project", async () => {
    const route = createRoute();
    const response = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(validCreateRequest()),
      }),
    );

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.requestId).toBe(validCreateRequest().requestId);
    expect(body.outcome.kind).toBe("created");
    expect(body.outcome.artifact.projectId).toBe(projectId);
    expect(body.outcome.artifact.displayName).toBe("Brief.docx");
    expect(body.outcome.previewTarget.kind).toBe("artifact-version");
    expect(JSON.stringify(body)).not.toMatch(/\/work|file:|\\\\/i);
  });
});

function createRoute(
  options: {
    readonly accessible?: boolean;
    readonly projectType?: "work" | "code";
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createWorkMutationRouteHandler({
    service: createService(),
    persistence: {
      readProject: vi.fn((id) => {
        if (String(id) !== String(projectId)) return undefined;
        return {
          id: projectId,
          name: "Knowledge",
          type: options.projectType ?? "work",
          lifecycle: "active",
          binding: { canonicalRoot: "/work" },
        } as never;
      }),
    },
    projects: {
      bootstrap: vi.fn().mockResolvedValue({
        active:
          options.accessible === false
            ? []
            : [
                {
                  id: projectId,
                  name: "Knowledge",
                  type: options.projectType ?? "work",
                  lifecycle: "active",
                },
              ],
        archived: [],
        availability: [],
        memory: [],
      }),
    },
    windowAuthorityStore: store,
    now: () => 1,
  });
}

function createService(filesystem: WorkFilesystemPort = workFilesystemFixture()) {
  const resolution = new WorkResolutionService(filesystem);
  const projection = new WorkArtifactProjection();
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
  };
  return new WorkMutationService({
    filesystem,
    resolution,
    projection,
    eventStore: {
      append: ({ frame }) => frame,
      replay: () => ({ status: "ok", frames: [], nextCursor: 0 }),
    },
    uuid,
    clock: () => "2026-07-26T20:00:00.000Z",
    actor,
    hostId: decodePreviewHostId("00000000-0000-4000-8000-000000000814"),
  });
}

function validCreateRequest(): WorkMutationRequest {
  return {
    kind: "create-artifact",
    requestId: "00000000-0000-4000-8000-000000000815" as never,
    projectId,
    format: "docx",
    displayName: "Brief.docx",
    content: "# Brief\nHello world",
  };
}
