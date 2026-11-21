import { describe, expect, it, vi } from "vitest";
import {
  decodeImageGenerationJobsResponse,
  decodeImageGenerationOfferDecisionResult,
  decodeImageGenerationOffersResponse,
  decodeImageGenerationProfilesResponse,
  decodeImageJob,
  decodeProviderInstanceId,
  decodeServiceOffersResponse,
  decodeWindowId,
  MAX_PENDING_IMAGE_GENERATION_OFFERS,
  type DeviceId,
  type ImageJob,
  type ProviderInstance,
  type RemoteSessionId,
  type ServiceOffer,
  type StableHostId,
} from "@octant/contracts";
import { listEligibleImageProfiles } from "@octant/domain";
import { ImageGenerationOfferService, type ImageOfferAnswer } from "./imageGenerationOfferService";
import { createImageRouteHandler } from "./imageRoutes";
import type { ImageJobService } from "./imageJobService";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createAuthenticatedProductDispatch } from "../authenticatedProductRoutes";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import { createServiceOfferRouteHandler } from "../offers/serviceOfferRoutes";
import { ServiceOfferService } from "../offers/serviceOfferService";
import { imageOfferDecisionRules } from "./imageOfferDecisionRules";

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
  const authorizeScope = vi.fn(async () => options.authorized !== false);
  let uuid = 0;
  const serviceOffers = new ServiceOfferService<ServiceOffer, ImageOfferAnswer>(
    MAX_PENDING_IMAGE_GENERATION_OFFERS,
    {
      uuid: () => `b3000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      now: () => nowMs,
    },
  );
  const offers = new ImageGenerationOfferService(serviceOffers);
  const remember = vi.fn<
    NonNullable<Parameters<typeof imageOfferDecisionRules>[0]["kept"]>["remember"]
  >(async (scope, choice) => offers.remember(scope, choice));
  const imageProfiles = {
    listInstances: () => options.instances ?? [imageProfile()],
    readImageGenerationSettings: () => ({ customSources: [] }),
  };
  const offerRoute = createServiceOfferRouteHandler({
    offers: serviceOffers,
    listImageProfiles: () => listEligibleImageProfiles(imageProfiles.listInstances()),
    rules: imageOfferDecisionRules({
      ...imageProfiles,
      kept: { remember },
    }),
    authorizeScope,
    windowAuthorityStore,
    now: () => nowMs,
  });
  const imageRoute = createImageRouteHandler({
    jobs: {
      enqueue,
      cancel,
      get: (id: string) => (options.jobs ?? [queuedJob()]).find((job) => String(job.id) === id),
      listByScope: () => options.jobs ?? [queuedJob()],
      readArtifact: async () => ({
        bytes: Uint8Array.from([1, 2, 3]),
        mime: "image/png" as const,
      }),
    } as unknown as ImageJobService,
    ...imageProfiles,
    authorizeScope,
    saveToProject,
    windowAuthorityStore,
    now: () => nowMs,
  });
  const handler = async (request: Request) =>
    (await offerRoute(request)) ?? (await imageRoute(request));
  return {
    handler,
    enqueue,
    cancel,
    saveToProject,
    authorizeScope,
    offers,
    serviceOffers,
    remember,
  };
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

  it("lists the image library's jobs for the library scope", async () => {
    const { handler } = setup();
    const response = await handler(
      request(`/api/image/jobs?threadKind=image-library&scopeId=${scopeId}`),
    );
    expect(response?.status).toBe(200);
    const body = decodeImageGenerationJobsResponse(await response!.json());
    expect(body.jobs[0]?.id).toBe(jobId);
  });

  it("lets a person-paired thread read its finished image, but never the library or an inaccessible result", async () => {
    const job = decodeImageJob({
      ...queuedJob(),
      status: "completed",
      artifacts: [
        {
          attachmentId,
          size: 3,
          mime: "image/png",
          hash: "b".repeat(64),
          evidence: {
            jobId,
            profileInstanceId: profileId,
            modelId: "gpt-image-2",
            promptHash: "a".repeat(64),
          },
        },
      ],
    });
    const { handler, authorizeScope } = setup({ jobs: [job] });
    const dispatch = createAuthenticatedProductDispatch({ dispatch: handler });
    const principal = createRemoteDevicePrincipal({
      hostId: crypto.randomUUID() as StableHostId,
      deviceId: crypto.randomUUID() as DeviceId,
      sessionId: crypto.randomUUID() as RemoteSessionId,
      origin: "https://octant.example",
      credentialGeneration: 1,
      protocolVersion: 1,
      capabilityDigest: "b".repeat(64),
      admittedBy: "host-person",
    });
    const get = (path: string) =>
      dispatch({
        principal,
        request: new Request(principal.origin + path),
        abortSignal: new AbortController().signal,
      });
    const path = `/api/image/thread-artifact?jobId=${jobId}&attachmentId=${attachmentId}`;
    const list = await get(`/api/image/jobs?threadKind=chat-thread&scopeId=${scopeId}`);
    expect(decodeImageGenerationJobsResponse(await list?.json()).jobs).toEqual([job]);
    const image = await get(path);
    expect(image?.status).toBe(206);
    expect(image?.headers.get("content-range")).toBe("bytes 0-2/3");
    expect(image?.headers.get("content-type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await (image ?? Response.error()).arrayBuffer()))).toEqual([
      1, 2, 3,
    ]);
    expect((await get(`/api/image/jobs?threadKind=image-library&scopeId=${scopeId}`))?.status).toBe(
      404,
    );
    authorizeScope.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await get(path))?.status).toBe(404);
    expect((await get(path + "&offset=3"))?.status).toBe(416);
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

  it.each(["work-thread", "code-thread"] as const)(
    "enqueues a %s job only for a thread the window can open",
    async (threadKind) => {
      const allowed = setup();
      const body = {
        threadKind,
        scopeId,
        profileInstanceId: profileId,
        modelId: "gpt-image-2",
        prompt: "a red cube",
      };
      const response = await allowed.handler(request("/api/image/jobs", { method: "POST", body }));
      expect(response?.status).toBe(200);
      expect(allowed.authorizeScope).toHaveBeenCalledWith(windowId, threadKind, scopeId);
      expect(allowed.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ threadKind, scopeId }),
      );

      const refused = setup({ authorized: false });
      const refusal = await refused.handler(request("/api/image/jobs", { method: "POST", body }));
      expect(refusal?.status).toBe(404);
      expect(refused.enqueue).not.toHaveBeenCalled();
    },
  );

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

  describe("an agent's image offer", () => {
    const scope = { threadKind: "code-thread" as const, scopeId: scopeId as never };
    const offer = {
      ...scope,
      kind: "generate" as const,
      prompt: "a lighthouse at dusk",
      variantCount: 1,
      revision: false,
      suggested: { profileInstanceId: profileId as never, modelId: "gpt-image-2" as never },
    };

    async function listed(handler: ReturnType<typeof setup>["handler"]) {
      const response = await handler(
        request(`/api/image/offers?threadKind=code-thread&scopeId=${scopeId}`),
      );
      return decodeImageGenerationOffersResponse(await response!.json()).offers;
    }

    it("preserves the legacy model refusal even after the offer is gone", async () => {
      const { handler } = setup();
      const body = {
        offerId: jobId,
        decision: "generate",
        profileInstanceId: profileId,
        modelId: "unavailable",
        rememberForThread: false,
      };
      const answer = await handler(request("/api/image/offers/decide", { method: "POST", body }));
      expect(await answer?.json()).toEqual({
        kind: "image-offer-refused",
        reason: "That image model is not available. Choose another one.",
      });
    });

    it("shows a waiting image request through the shared offers endpoint and claims it only once across endpoints", async () => {
      const { handler, offers } = setup();
      const outcome = offers.offer({ windowId: windowId as never, offer });
      const response = await handler(
        request(`/api/offers?threadKind=code-thread&scopeId=${scopeId}`),
      );
      expect(response?.status).toBe(200);
      const [waiting] = decodeServiceOffersResponse(await response?.json()).offers;
      expect(waiting).toMatchObject({ kind: "generate" });
      const body = { offerId: waiting?.offerId, decision: "cancel" };
      const shared = await handler(request("/api/offers/decide", { method: "POST", body }));
      expect(await shared?.json()).toMatchObject({ kind: "offer-answered" });
      await expect(outcome).resolves.toEqual({ status: "cancelled" });
      const legacy = await handler(request("/api/image/offers/decide", { method: "POST", body }));
      expect(await legacy?.json()).toMatchObject({ kind: "image-offer-gone" });
    });

    it("lets a person-paired device answer only its own offer and rechecks access before claiming", async () => {
      const { handler, offers, authorizeScope, serviceOffers, remember } = setup();
      const dispatch = createAuthenticatedProductDispatch({ dispatch: handler });
      const deviceScope = decodeWindowId("22222222-2222-4222-8222-222222222222");
      const principal = createRemoteDevicePrincipal({
        hostId: "11111111-1111-4111-8111-111111111111" as StableHostId,
        deviceId: String(deviceScope) as DeviceId,
        credentialGeneration: 1,
        origin: "https://octant.example",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "33333333-3333-4333-8333-333333333333" as RemoteSessionId,
        admittedBy: "host-person",
      });
      const local = offers.offer({ windowId: decodeWindowId(windowId), offer });
      const device = offers.offer({ windowId: deviceScope, offer });
      const send = (request: Request) =>
        dispatch({ request, principal, abortSignal: new AbortController().signal });
      const listed = await send(
        new Request(`https://octant.example/api/offers?threadKind=code-thread&scopeId=${scopeId}`),
      );
      expect(listed?.status).toBe(200);
      const [waiting] = serviceOffers.list(deviceScope, scope);
      const list = decodeServiceOffersResponse(await listed?.json());
      expect(list.offers).toEqual([waiting]);
      expect(list.imageProfiles).toMatchObject([
        { instanceId: profileId, modelAllowlist: ["gpt-image-2"] },
      ]);
      const generate = () =>
        send(
          new Request("https://octant.example/api/offers/decide", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              offerId: waiting?.offerId,
              decision: "generate",
              profileInstanceId: profileId,
              modelId: "gpt-image-2",
              rememberForThread: true,
            }),
          }),
        );
      authorizeScope.mockResolvedValueOnce(false);
      expect((await generate())?.status).toBe(404);
      expect(remember).not.toHaveBeenCalled();
      expect(serviceOffers.list(deviceScope, scope)).toEqual([waiting]);
      expect(await (await generate())?.json()).toEqual({ kind: "offer-answered" });
      const choice = { profileInstanceId: profileId, modelId: "gpt-image-2" };
      await expect(device).resolves.toEqual({ status: "generate", ...choice });
      expect(remember).toHaveBeenCalledExactlyOnceWith(waiting, choice, {
        kind: "remote-device",
        actorId: String(deviceScope),
        deviceId: String(deviceScope),
      });
      expect(serviceOffers.list(decodeWindowId(windowId), scope)).toHaveLength(1);
      serviceOffers.close();
      await expect(local).resolves.toEqual({ status: "cancelled" });
    });

    it("shows the waiting offer to the asking window and runs the model the person chose", async () => {
      const { handler, offers } = setup();
      const outcome = offers.offer({ windowId: windowId as never, offer });
      const [waiting] = await listed(handler);
      expect(waiting).toMatchObject({ kind: "generate", prompt: "a lighthouse at dusk" });
      const response = await handler(
        request("/api/image/offers/decide", {
          method: "POST",
          body: {
            offerId: waiting?.offerId,
            decision: "generate",
            profileInstanceId: profileId,
            modelId: "gpt-image-2",
            rememberForThread: true,
          },
        }),
      );
      expect(decodeImageGenerationOfferDecisionResult(await response!.json())).toEqual({
        kind: "image-offer-answered",
      });
      await expect(outcome).resolves.toEqual({
        status: "generate",
        profileInstanceId: profileId,
        modelId: "gpt-image-2",
      });
      expect(offers.remembered(scope)).toEqual({
        profileInstanceId: profileId,
        modelId: "gpt-image-2",
      });
      expect(await listed(handler)).toEqual([]);
    });

    it("keeps the offer waiting when the chosen model is not one the host can run", async () => {
      const { handler, offers } = setup();
      void offers.offer({ windowId: windowId as never, offer });
      const [waiting] = await listed(handler);
      const response = await handler(
        request("/api/image/offers/decide", {
          method: "POST",
          body: {
            offerId: waiting?.offerId,
            decision: "generate",
            profileInstanceId: profileId,
            modelId: "not-on-the-allowlist",
            rememberForThread: true,
          },
        }),
      );
      expect(decodeImageGenerationOfferDecisionResult(await response!.json())).toMatchObject({
        kind: "image-offer-refused",
      });
      expect(await listed(handler)).toHaveLength(1);
      expect(offers.remembered(scope)).toBeUndefined();
    });

    it("lets the agent draw it without remembering anything, and answers a second click as gone", async () => {
      const { handler, offers } = setup();
      const outcome = offers.offer({ windowId: windowId as never, offer });
      const [waiting] = await listed(handler);
      const decide = () =>
        handler(
          request("/api/image/offers/decide", {
            method: "POST",
            body: { offerId: waiting?.offerId, decision: "agent-draws" },
          }),
        );
      await decide();
      await expect(outcome).resolves.toEqual({ status: "agent-draws" });
      expect(decodeImageGenerationOfferDecisionResult(await (await decide())!.json())).toEqual({
        kind: "image-offer-gone",
      });
      expect(offers.remembered(scope)).toBeUndefined();
    });

    it("shows another window nothing and lets it answer nothing", async () => {
      const { handler, offers, serviceOffers } = setup();
      const otherWindow = "70000000-0000-4000-8000-000000000002";
      const outcome = offers.offer({ windowId: otherWindow as never, offer });
      expect(await listed(handler)).toEqual([]);
      const [waiting] = serviceOffers.list(otherWindow as never, scope);
      const response = await handler(
        request("/api/image/offers/decide", {
          method: "POST",
          body: { offerId: waiting?.offerId, decision: "cancel" },
        }),
      );
      expect(decodeImageGenerationOfferDecisionResult(await response!.json())).toEqual({
        kind: "image-offer-gone",
      });
      serviceOffers.revokeWindow(otherWindow as never);
      await expect(outcome).resolves.toEqual({ status: "cancelled" });
    });

    it("refuses an answer from a window that can no longer open the thread and keeps the offer waiting", async () => {
      const { handler, offers, serviceOffers } = setup({ authorized: false });
      let settled = false;
      void offers.offer({ windowId: windowId as never, offer }).then(() => {
        settled = true;
      });
      const [waiting] = serviceOffers.list(windowId as never, scope);
      const response = await handler(
        request("/api/image/offers/decide", {
          method: "POST",
          body: {
            offerId: waiting?.offerId,
            decision: "generate",
            profileInstanceId: profileId,
            modelId: "gpt-image-2",
            rememberForThread: true,
          },
        }),
      );
      expect(response?.status).toBe(404);
      expect(serviceOffers.list(windowId as never, scope)).toHaveLength(1);
      expect(offers.remembered(scope)).toBeUndefined();
      await Promise.resolve();
      expect(settled).toBe(false);
      serviceOffers.close();
    });

    it("keeps an offer waiting a day later, and gives it up when its thread is archived", async () => {
      vi.useFakeTimers();
      try {
        const { offers, serviceOffers } = setup();
        const outcome = offers.offer({ windowId: windowId as never, offer });
        await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
        expect(serviceOffers.list(windowId as never, scope)).toHaveLength(1);
        // Nothing is left behind to fire later: the wait holds no timer.
        expect(vi.getTimerCount()).toBe(0);

        serviceOffers.withdrawThread("b3000000-0000-4000-8000-00000000dead");
        expect(serviceOffers.list(windowId as never, scope)).toHaveLength(1);
        serviceOffers.withdrawThread(scopeId);
        await expect(outcome).resolves.toEqual({ status: "cancelled" });
        expect(serviceOffers.list(windowId as never, scope)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("saves only on a save request, and refuses an answer that fits the other kind", async () => {
      const { handler, offers, serviceOffers } = setup();
      const saveOutcome = offers.offer({
        windowId: windowId as never,
        offer: {
          ...scope,
          kind: "save",
          jobId: jobId as never,
          attachmentId: attachmentId as never,
          relativePath: "art/lighthouse.png",
        },
      });
      void offers.offer({ windowId: windowId as never, offer });
      const [saveOffer, generateOffer] = serviceOffers.list(windowId as never, scope);
      const decide = async (body: unknown) =>
        decodeImageGenerationOfferDecisionResult(
          await (await handler(
            request("/api/image/offers/decide", { method: "POST", body }),
          ))!.json(),
        );

      expect(await decide({ offerId: generateOffer?.offerId, decision: "save" })).toMatchObject({
        kind: "image-offer-refused",
      });
      expect(
        await decide({
          offerId: saveOffer?.offerId,
          decision: "generate",
          profileInstanceId: profileId,
          modelId: "gpt-image-2",
          rememberForThread: false,
        }),
      ).toMatchObject({ kind: "image-offer-refused" });
      expect(await decide({ offerId: saveOffer?.offerId, decision: "save" })).toEqual({
        kind: "image-offer-answered",
      });
      await expect(saveOutcome).resolves.toEqual({ status: "save" });
      serviceOffers.close();
    });

    it("does not list offers for a thread the window cannot open", async () => {
      const { handler } = setup({ authorized: false });
      const response = await handler(
        request(`/api/image/offers?threadKind=code-thread&scopeId=${scopeId}`),
      );
      expect(response?.status).toBe(404);
    });
  });
});
