import { describe, expect, it, vi } from "vitest";
import { decodeProjectId, decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import {
  createWorkResearchRouteHandler,
  type WorkResearchRouteDependencies,
} from "./workResearchRoutes";
import type { WorkResearchBriefEntry } from "./work/workResearchProjection";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000902");
const otherProjectId = decodeProjectId("00000000-0000-4000-8000-000000000903");
const briefsUrl = `http://127.0.0.1/api/work/research/briefs?projectId=${String(projectId)}`;
const commandsUrl = "http://127.0.0.1/api/work/research/commands";

function validCommand() {
  return {
    kind: "create-brief",
    requestId: "00000000-0000-4000-8000-000000000904",
    projectId,
    briefId: "00000000-0000-4000-8000-000000000905",
    questions: ["What changed?"],
    sourcePolicy: { allowedKinds: ["file"], maxSources: 4, excerptByteBudget: 1024 },
    deliverables: ["report"],
  };
}

const actor = { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000907" } as const;

function fullBrief(briefId = "00000000-0000-4000-8000-000000000905") {
  return {
    briefId,
    projectId,
    questions: ["What changed?"],
    sourcePolicy: { allowedKinds: ["file"], maxSources: 4, excerptByteBudget: 1024 },
    notes: [],
    deliverables: ["report"],
    status: "draft",
    createdBy: actor,
    createdAt: "2026-08-15T00:00:00.000Z",
    version: 1,
  };
}

function briefCreatedResult() {
  return {
    kind: "brief-created",
    requestId: "00000000-0000-4000-8000-000000000904",
    brief: fullBrief(),
  };
}

function briefEntry(
  owner = projectId,
  briefId = "00000000-0000-4000-8000-000000000905",
): WorkResearchBriefEntry {
  return {
    briefId,
    brief: { briefId, projectId: owner, status: "draft", questions: [] },
    sources: new Map(),
    revokedSourceIds: new Set(),
    evidence: [],
    claims: [],
  } as unknown as WorkResearchBriefEntry;
}

function createRoute(
  options: {
    readonly accessible?: boolean;
    readonly projectType?: "work" | "code";
    readonly entries?: ReadonlyArray<WorkResearchBriefEntry>;
    readonly execute?: WorkResearchRouteDependencies["service"]["execute"];
    readonly projectionRebuilt?: boolean;
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const snapshot = new Map<unknown, WorkResearchBriefEntry>(
    (options.entries ?? []).map((entry) => [entry.briefId, entry]),
  );
  return createWorkResearchRouteHandler({
    service: {
      execute: options.execute ?? vi.fn().mockResolvedValue(briefCreatedResult()),
    },
    projection: { snapshot: () => snapshot },
    projectionRebuilt: () => options.projectionRebuilt ?? true,
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

const authHeaders = {
  "content-type": "application/json",
  "x-octant-window-capability": capability,
};

describe("Work research routes", () => {
  it("ignores paths it does not own", async () => {
    const response = await createRoute()(new Request("http://127.0.0.1/api/work/mutations"));

    expect(response).toBeUndefined();
  });

  it("requires window capability authentication for commands", async () => {
    const response = await createRoute()(
      new Request(commandsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validCommand()),
      }),
    );

    expect(response?.status).toBe(401);
  });

  it("requires window capability authentication for briefs", async () => {
    const response = await createRoute()(new Request(briefsUrl));

    expect(response?.status).toBe(401);
  });

  it("rejects a request that tries to supply window identity", async () => {
    const response = await createRoute()(
      new Request(commandsUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ...validCommand(), windowId }),
      }),
    );

    expect(response?.status).toBe(400);
  });

  it("rejects a non-loopback host", async () => {
    const response = await createRoute()(
      new Request("http://example.test/api/work/research/commands", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validCommand()),
      }),
    );

    expect(response?.status).toBe(400);
  });

  it("rejects a Project the window cannot reach", async () => {
    const response = await createRoute({ accessible: false })(
      new Request(commandsUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validCommand()),
      }),
    );

    expect(response?.status).toBe(404);
  });

  it("rejects a Code Project", async () => {
    const response = await createRoute({ projectType: "code" })(
      new Request(commandsUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validCommand()),
      }),
    );

    expect(response?.status).toBe(404);
  });

  it("rejects a malformed command before reaching the service", async () => {
    const execute = vi.fn();
    const response = await createRoute({ execute })(
      new Request(commandsUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ kind: "create-brief", projectId }),
      }),
    );

    expect(response?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes an authorized command and returns the typed result", async () => {
    const execute = vi.fn().mockResolvedValue(briefCreatedResult());
    const response = await createRoute({ execute })(
      new Request(commandsUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validCommand()),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ kind: "brief-created" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns only briefs belonging to the requested Project", async () => {
    const response = await createRoute({
      entries: [briefEntry(), briefEntry(otherProjectId, "00000000-0000-4000-8000-000000000906")],
    })(new Request(briefsUrl, { headers: { "x-octant-window-capability": capability } }));

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      briefs: ReadonlyArray<{ brief: { projectId: string } }>;
    };
    expect(body.briefs).toHaveLength(1);
    expect(String(body.briefs[0]?.brief.projectId)).toBe(String(projectId));
  });

  it("reports research unavailable rather than an empty brief list when the projection could not be rebuilt", async () => {
    const execute = vi.fn();
    const listing = await createRoute({
      projectionRebuilt: false,
      entries: [briefEntry()],
      execute,
    })(new Request(briefsUrl, { headers: { "x-octant-window-capability": capability } }));

    expect(listing?.status).toBe(503);
    const body = (await listing?.json()) as {
      readonly briefs?: unknown;
      readonly message?: string;
    };
    expect(body.briefs).toBeUndefined();
    expect(body.message).toContain("unavailable");

    const command = await createRoute({ projectionRebuilt: false, execute })(
      new Request(commandsUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validCommand()),
      }),
    );

    expect(command?.status).toBe(503);
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires a projectId when listing briefs", async () => {
    const response = await createRoute()(
      new Request("http://127.0.0.1/api/work/research/briefs", {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(400);
  });

  it("fails closed when the service returns a result that is not a valid contract", async () => {
    const execute = vi.fn().mockResolvedValue({ kind: "accepted" });
    const response = await createRoute({ execute })(
      new Request(commandsUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(validCommand()),
      }),
    );

    expect(response?.status).toBe(503);
  });

  it("rejects an oversized body", async () => {
    const response = await createRoute()(
      new Request(commandsUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ...validCommand(), pad: "x".repeat(64) }),
      }),
    );

    expect([400, 413]).toContain(response?.status);
  });
});
