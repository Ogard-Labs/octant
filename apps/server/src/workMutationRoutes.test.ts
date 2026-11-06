import { approvedWorkingFolderChoices } from "./approvedWorkingFolders";
import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  decodeProjectId,
  decodeProject,
  decodeWindowId,
  decodeWorkMutationReply,
  type WorkMutationRequest,
} from "@octant/contracts";
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

  it("places an artifact made for a thread in that thread's working directory and refuses a thread of another Project", async () => {
    const mutate = vi.fn(async (request: WorkMutationRequest, _context: unknown) => ({
      requestId: request.requestId,
      outcome: { kind: "interrupted" as const, canRetry: true },
    }));
    const route = createRoute({
      service: { mutate } as never,
      readThread: (id) =>
        String(id) === threadId
          ? { projectId, workingDirectory: "research/brief" }
          : String(id) === otherThreadId
            ? { projectId: "00000000-0000-4000-8000-0000000008ff" as never }
            : undefined,
    });
    const send = (id: string) =>
      route(
        new Request("http://127.0.0.1/api/work/mutations", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify({ ...validCreateRequest(), threadId: id }),
        }),
      );

    await send(threadId);
    expect(mutate.mock.lastCall?.[1]).toMatchObject({ directory: "research/brief" });

    expect((await send(otherThreadId))?.status).toBe(404);
    expect((await send("00000000-0000-4000-8000-0000000008ee"))?.status).toBe(404);
  });

  it("uses the thread's approved folder and refuses its removed or re-added identity without a main-folder fallback", async () => {
    const now = "2026-11-06T12:00:00.000Z";
    const base = {
      id: projectId,
      name: "Knowledge",
      type: "work",
      lifecycle: "active",
      pinned: false,
      rank: "0/1",
      version: 1,
      createdAt: now,
      updatedAt: now,
      binding: { canonicalRoot: "/work" },
      bindingHistory: [
        {
          revisionId: "00000000-0000-4000-8000-0000000008e1",
          revision: 1,
          currentBinding: { canonicalRoot: "/work" },
          actor,
          changedAt: now,
        },
      ],
      extraFolders: [
        { canonicalRoot: "/approved/notes", addedAt: now, addedBy: actor, addedRevision: 1 },
      ],
    };
    let project = decodeProject(base);
    if (project.type !== "work") throw new Error("Expected Work Project");
    const selected = approvedWorkingFolderChoices(project).find(
      (folder) => folder.kind === "extra",
    );
    if (selected === undefined) throw new Error("Expected folder choice");
    const mutate = vi.fn(async (request: WorkMutationRequest, _context: unknown) => ({
      requestId: request.requestId,
      outcome: { kind: "interrupted" as const, canRetry: true },
    }));
    const route = createRoute({
      service: { mutate },
      readProject: () => project,
      readThread: () => ({ projectId, workingFolderId: selected.id, workingDirectory: "drafts" }),
    });
    const send = () =>
      route(
        new Request("http://127.0.0.1/api/work/mutations", {
          method: "POST",
          headers: { "content-type": "application/json", "x-octant-window-capability": capability },
          body: JSON.stringify({ ...validCreateRequest(), threadId }),
        }),
      );
    expect((await send())?.status).toBe(200);
    expect(mutate.mock.lastCall?.[1]).toMatchObject({
      workingFolderId: selected.id,
      directory: "drafts",
      binding: { canonicalRoot: "/approved/notes" },
    });
    project = decodeProject({ ...base, extraFolders: [] });
    expect((await send())?.status).toBe(404);
    project = decodeProject({
      ...base,
      extraFolders: [{ ...base.extraFolders[0], addedRevision: 2 }],
    });
    expect((await send())?.status).toBe(404);
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("refuses a destructive delete until confirmation is recorded", async () => {
    const route = createRoute();
    const created = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(validCreateRequest()),
      }),
    );
    expect(created?.status).toBe(200);
    const createdBody = decodeWorkMutationReply(await created?.json());
    expect(createdBody.outcome.kind).toBe("created");
    if (createdBody.outcome.kind !== "created") return;

    const response = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "delete-artifact",
          requestId: "00000000-0000-4000-8000-000000000816",
          projectId,
          artifactId: createdBody.outcome.artifact.artifactId,
          expectedArtifactVersion: 1,
        }),
      }),
    );

    expect(response?.status).toBe(200);
    const body = decodeWorkMutationReply(await response?.json());
    expect(body.outcome.kind).toBe("unauthorized");
  });

  it("refuses a lossy transform until confirmation is recorded", async () => {
    const route = createRoute();
    const created = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(validCreateRequest()),
      }),
    );
    const createdBody = decodeWorkMutationReply(await created?.json());
    expect(createdBody.outcome.kind).toBe("created");
    if (createdBody.outcome.kind !== "created") return;

    const response = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "transform-artifact",
          requestId: "00000000-0000-4000-8000-000000000818",
          projectId,
          artifactId: createdBody.outcome.artifact.artifactId,
          targetFormat: "markdown",
          expectedArtifactVersion: 1,
        }),
      }),
    );

    expect(response?.status).toBe(200);
    const body = decodeWorkMutationReply(await response?.json());
    expect(body.outcome.kind).toBe("unauthorized");
  });

  it("deletes a Work artifact when confirmation is recorded", async () => {
    const route = createRoute();
    const created = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify(validCreateRequest()),
      }),
    );
    const createdBody = decodeWorkMutationReply(await created?.json());
    expect(createdBody.outcome.kind).toBe("created");
    if (createdBody.outcome.kind !== "created") return;

    const response = await route(
      new Request("http://127.0.0.1/api/work/mutations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "delete-artifact",
          requestId: "00000000-0000-4000-8000-000000000817",
          projectId,
          artifactId: createdBody.outcome.artifact.artifactId,
          expectedArtifactVersion: 1,
          confirmed: true,
        }),
      }),
    );

    expect(response?.status).toBe(200);
    const body = decodeWorkMutationReply(await response?.json());
    expect(body.outcome.kind).toBe("deleted");
    if (body.outcome.kind !== "deleted") return;
    expect(body.outcome.artifactId).toBe(createdBody.outcome.artifact.artifactId);
  });
});

const threadId = "00000000-0000-4000-8000-0000000008a1";
const otherThreadId = "00000000-0000-4000-8000-0000000008a2";

function createRoute(
  options: {
    readonly accessible?: boolean;
    readonly projectType?: "work" | "code";
    readonly service?: Parameters<typeof createWorkMutationRouteHandler>[0]["service"];
    readonly readThread?: Parameters<typeof createWorkMutationRouteHandler>[0]["readThread"];
    readonly readArtifact?: Parameters<typeof createWorkMutationRouteHandler>[0]["readArtifact"];
    readonly readProject?: Parameters<
      typeof createWorkMutationRouteHandler
    >[0]["persistence"]["readProject"];
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const fixture = createService();
  return createWorkMutationRouteHandler({
    service: options.service ?? fixture.service,
    ...(options.readArtifact !== undefined
      ? { readArtifact: options.readArtifact }
      : options.service === undefined
        ? { readArtifact: (id) => fixture.projection.lookup(id) }
        : {}),
    ...(options.readThread === undefined ? {} : { readThread: options.readThread }),
    persistence: {
      readProject:
        options.readProject ??
        vi.fn((id) => {
          if (String(id) !== String(projectId)) return undefined;
          return {
            id: projectId,
            name: "Knowledge",
            type: options.projectType ?? "work",
            lifecycle: "active",
            binding: { canonicalRoot: "/work" },
            bindingHistory: [{ revisionId: "00000000-0000-4000-8000-0000000008e1" }],
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
  const service = new WorkMutationService({
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
  return { service, projection };
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
