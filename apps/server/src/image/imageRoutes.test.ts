import { describe, expect, it, vi } from "vitest";
import {
  decodeImageGenerationJobsResponse,
  decodeImageGenerationProfilesResponse,
  decodeImageJob,
  decodeProviderInstanceId,
  type ImageJob,
  type ProviderInstance,
} from "@octant/contracts";
import { createImageRouteHandler } from "./imageRoutes";
import type { ImageJobService } from "./imageJobService";
import { WindowAuthorityStore } from "../windowAuthorityStore";

const nowMs = Date.parse("2026-08-28T12:00:00.000Z");
const windowId = "70000000-0000-4000-8000-000000000001";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const scopeId = "a3000000-0000-4000-8000-000000000002";
const profileId = "a3000000-0000-4000-8000-000000000001";
const jobId = "a3000000-0000-4000-8000-000000000003";
const attachmentId = "a3000000-0000-4000-8000-000000000010";
const origin = "http://127.0.0.1:5173";

function imageProfile(): ProviderInstance {
  return {
    id: decodeProviderInstanceId(profileId),
    displayName: "OpenAI Image",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: "2026-08-28T12:00:00.000Z" as ProviderInstance["createdAt"],
    updatedAt: "2026-08-28T12:00:00.000Z" as ProviderInstance["updatedAt"],
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2" as never],
      defaultModel: "gpt-image-2" as never,
    },
  };
}

function queuedJob(): ImageJob {
  return decodeImageJob({
    id: jobId,
    status: "queued",
    threadKind: "chat-thread",
    scopeId,
    profileInstanceId: profileId,
    modelId: "gpt-image-2",
    promptHash: "a".repeat(64),
    artifacts: [],
    version: 1,
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
  });
}

function setup(
  options: {
    readonly instances?: ReadonlyArray<ProviderInstance>;
    readonly authorized?: boolean;
    readonly jobs?: ReadonlyArray<ImageJob>;
  } = {},
) {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
  const enqueue = vi.fn(async () => queuedJob());
  const cancel = vi.fn(async () => ({ ...queuedJob(), status: "cancelled" as const }));
  const saveToProject = vi.fn(async () => ({
    status: "refused" as const,
    reason: "Chat artifacts grant no filesystem authority.",
  }));
  const handler = createImageRouteHandler({
    jobs: {
      enqueue,
      cancel,
      get: (id: string) => (String(id) === jobId ? queuedJob() : undefined),
      listByScope: () => options.jobs ?? [queuedJob()],
      readArtifact: async () => ({
        bytes: Uint8Array.from([1, 2, 3]),
        mime: "image/png" as const,
      }),
    } as unknown as ImageJobService,
    listInstances: () => options.instances ?? [imageProfile()],
    authorizeScope: async () => options.authorized !== false,
    saveToProject,
    windowAuthorityStore,
    now: () => nowMs,
  });
  return { handler, enqueue, cancel, saveToProject };
}

function request(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly capability?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    origin,
    "content-type": "application/json",
  };
  if (options.capability !== "omit") {
    headers["x-octant-window-capability"] = options.capability ?? capability;
  }
  return new Request(`http://127.0.0.1:3100${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("image routes", () => {
  it("lists enabled image profiles", async () => {
    const { handler } = setup();
    const response = await handler(request("/api/image/profiles"));
    expect(response?.status).toBe(200);
    const body = decodeImageGenerationProfilesResponse(await response!.json());
    expect(body.profiles[0]?.displayName).toBe("OpenAI Image");
  });

  it("hides disabled image profiles", async () => {
    const disabled = { ...imageProfile(), enabled: false };
    const { handler } = setup({ instances: [disabled] });
    const response = await handler(request("/api/image/profiles"));
    const body = decodeImageGenerationProfilesResponse(await response!.json());
    expect(body.profiles).toEqual([]);
  });

  it("lists jobs for an authorized thread", async () => {
    const { handler } = setup();
    const response = await handler(
      request(`/api/image/jobs?threadKind=chat-thread&scopeId=${scopeId}`),
    );
    const body = decodeImageGenerationJobsResponse(await response!.json());
    expect(body.jobs[0]?.id).toBe(jobId);
  });

  it("enqueues a job for an authorized thread", async () => {
    const { handler, enqueue } = setup();
    const response = await handler(
      request("/api/image/jobs", {
        method: "POST",
        body: {
          threadKind: "chat-thread",
          scopeId,
          profileInstanceId: profileId,
          modelId: "gpt-image-2",
          prompt: "a red cube",
          variantCount: 2,
        },
      }),
    );
    expect(response?.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a red cube", variantCount: 2 }),
    );
  });

  it("cancels a running job", async () => {
    const { handler, cancel } = setup();
    const response = await handler(
      request(`/api/image/jobs/${jobId}/cancel`, { method: "POST", body: {} }),
    );
    expect(response?.status).toBe(200);
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses Chat project save", async () => {
    const { handler, saveToProject } = setup();
    const response = await handler(
      request(`/api/image/jobs/${jobId}/artifacts/${attachmentId}/save`, {
        method: "POST",
        body: { relativePath: "generated/cube.png" },
      }),
    );
    expect(response?.status).toBe(403);
    expect(saveToProject).toHaveBeenCalled();
    const body = (await response!.json()) as { readonly reason: string };
    expect(body.reason).toMatch(/no filesystem authority/i);
  });

  it("does not disclose jobs for a thread the window cannot open", async () => {
    const { handler } = setup({ authorized: false });
    const response = await handler(
      request(`/api/image/jobs?threadKind=chat-thread&scopeId=${scopeId}`),
    );
    expect(response?.status).toBe(404);
  });
});
