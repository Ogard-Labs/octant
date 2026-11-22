import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeAggregateVersion,
  decodeImageGenerationJobsResponse,
  decodeImageGenerationOfferDecisionResult,
  decodeImageGenerationOffersResponse,
  decodeImageGenerationProfilesResponse,
  decodeImageJob,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeServiceOffersResponse,
  decodeWindowId,
  MAX_PENDING_IMAGE_GENERATION_OFFERS,
  THREAD_IMAGE_CHUNK_BYTES,
  type DeviceId,
  type ImageArtifactId,
  type ImageJob,
  type ImageJobId,
  type ProviderInstance,
  type RemoteSessionId,
  type ServiceOffer,
  type StableHostId,
} from "@octant/contracts";
import { listEligibleImageProfiles } from "@octant/domain";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { SpendCeilingService } from "../spendCeilingService";
import { GeneratedImageStore } from "./generatedImageStore";
import { ImageGenerationOfferService } from "./imageGenerationOfferService";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import { narrationDecision } from "../speech/narrationTool";
import { transcriptionDecision } from "../speech/transcriptionTool";
import { decodeNarrationOffer, decodeTranscriptionOffer } from "@octant/contracts";
import { createImageRouteHandler } from "./imageRoutes";
import { ImageJobService } from "./imageJobService";
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
  const serviceOffers = new ServiceOfferService<ServiceOffer, ServiceOfferAnswer>(
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
    rules: {
      transcribe: transcriptionDecision,
      narrate: narrationDecision,
      ...imageOfferDecisionRules({
        ...imageProfiles,
        kept: { remember },
      }),
    },
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

    it("shows a recording only to clients with its disclosure and permits one matching answer", async () => {
      const { handler, serviceOffers } = setup();
      const pending = serviceOffers.wait({
        windowId: decodeWindowId(windowId),
        stamp: (offerId, requestedAt) =>
          decodeTranscriptionOffer({
            kind: "transcribe",
            threadKind: "code-thread",
            scopeId,
            offerId,
            requestedAt,
            relativePath: "audio.m4a",
            sizeBytes: 123,
            endpointName: "Studio",
            modelId: "voice",
          }),
      });
      const query = `threadKind=code-thread&scopeId=${scopeId}`;
      for (const path of ["/api/image/offers?", "/api/offers?referenceImages=1&"]) {
        const response = await handler(request(path + query));
        expect(await response?.json()).toEqual({ offers: [] });
      }
      const [offer] = decodeServiceOffersResponse(
        await (await handler(request("/api/offers?transcription=1&" + query)))?.json(),
      ).offers;
      expect(offer?.kind).toBe("transcribe");
      const decide = async (body: object) =>
        (
          await handler(
            request("/api/offers/decide", {
              method: "POST",
              body: { offerId: offer?.offerId, ...body },
            }),
          )
        )?.json();
      expect(await decide({ decision: "save" })).toMatchObject({ kind: "offer-refused" });
      expect(await decide({ decision: "transcribe", rememberForThread: true })).toEqual({
        kind: "offer-answered",
      });
      expect(await decide({ decision: "transcribe", rememberForThread: true })).toEqual({
        kind: "offer-gone",
      });
      expect(await pending).toEqual({ status: "transcribe", rememberForThread: true });
    });

    it("shows a narration offer only to clients with its disclosure and permits one matching answer", async () => {
      const { handler, serviceOffers } = setup();
      const pending = serviceOffers.wait({
        windowId: decodeWindowId(windowId),
        stamp: (offerId, requestedAt) =>
          decodeNarrationOffer({
            kind: "narrate",
            threadKind: "code-thread",
            scopeId,
            offerId,
            requestedAt,
            excerpt: "Welcome to the demo.",
            characters: 20,
            relativePath: "narration/intro.mp3",
            voice: "alloy",
            endpointName: "Studio",
            modelId: "tts-1",
            format: "mp3",
          }),
      });
      const query = `threadKind=code-thread&scopeId=${scopeId}`;
      for (const path of [
        "/api/image/offers?",
        "/api/offers?referenceImages=1&",
        "/api/offers?transcription=1&",
      ]) {
        const response = await handler(request(path + query));
        expect(await response?.json()).toEqual({ offers: [] });
      }
      const [offer] = decodeServiceOffersResponse(
        await (await handler(request("/api/offers?narration=1&" + query)))?.json(),
      ).offers;
      expect(offer?.kind).toBe("narrate");
      const decide = async (body: object) =>
        (
          await handler(
            request("/api/offers/decide", {
              method: "POST",
              body: { offerId: offer?.offerId, ...body },
            }),
          )
        )?.json();
      expect(await decide({ decision: "transcribe", rememberForThread: false })).toMatchObject({
        kind: "offer-refused",
      });
      expect(await decide({ decision: "narrate", rememberForThread: true })).toEqual({
        kind: "offer-answered",
      });
      expect(await decide({ decision: "narrate", rememberForThread: true })).toEqual({
        kind: "offer-gone",
      });
      expect(await pending).toEqual({ status: "narrate", rememberForThread: true });
    });

    it("shows reference offers only to current clients and requires disclosure and a compatible model", async () => {
      const incompatibleId = decodeProviderInstanceId(attachmentId);
      const incompatible = {
        ...imageProfile(),
        id: incompatibleId,
        driverKind: "bfl-image",
        configuration: {
          kind: "bfl-image-http",
          modelAllowlist: ["flux-pro" as never],
          defaultModel: "flux-pro" as never,
        },
      } satisfies ProviderInstance;
      const { handler, offers } = setup({ instances: [imageProfile(), incompatible] });
      const references = [{ kind: "file", label: "art/logo.png" }] as const;
      const outcome = offers.offer({
        windowId: windowId as never,
        offer: { ...offer, references },
      });
      const query = `threadKind=code-thread&scopeId=${scopeId}`;
      expect(await listed(handler)).toEqual([]);
      const oldClient = await handler(request(`/api/offers?${query}`));
      expect(decodeServiceOffersResponse(await oldClient?.json()).offers).toEqual([]);
      const currentClient = await handler(request(`/api/offers?${query}&referenceImages=1`));
      const [waiting] = decodeServiceOffersResponse(await currentClient?.json()).offers;
      expect(waiting).toMatchObject({ references });
      const body = {
        offerId: waiting?.offerId,
        decision: "generate",
        profileInstanceId: profileId,
        modelId: "gpt-image-2",
        rememberForThread: true,
      };
      const decide = (answer: Record<string, unknown>) =>
        handler(request("/api/offers/decide", { method: "POST", body: answer }));
      expect(await (await decide(body))?.json()).toMatchObject({
        kind: "offer-refused",
        reason: expect.stringContaining("shows which images"),
      });
      const disclosed = { ...body, referenceImagesConfirmed: true };
      expect(
        await (
          await decide({
            ...disclosed,
            profileInstanceId: incompatibleId,
            modelId: "flux-pro",
          })
        )?.json(),
      ).toMatchObject({
        kind: "offer-refused",
        reason: expect.stringContaining("can't use reference images"),
      });
      expect(await (await decide(disclosed))?.json()).toEqual({ kind: "offer-answered" });
      await expect(outcome).resolves.toMatchObject({
        status: "generate",
        profileInstanceId: profileId,
      });
      expect(offers.remembered(scope)).toBeUndefined();
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

    it("shows an icon set's save only to clients that say how many files it writes", async () => {
      const { handler, offers, serviceOffers } = setup();
      void offers.offer({
        windowId: windowId as never,
        offer: {
          ...scope,
          kind: "save",
          jobId: jobId as never,
          attachmentId: attachmentId as never,
          relativePath: "App/Assets.xcassets",
          fileCount: 11,
        },
      });
      const query = `threadKind=code-thread&scopeId=${scopeId}`;
      expect(await listed(handler)).toEqual([]);
      const oldClient = await handler(request(`/api/offers?${query}&referenceImages=1`));
      expect(decodeServiceOffersResponse(await oldClient?.json()).offers).toEqual([]);
      const currentClient = await handler(request(`/api/offers?${query}&iconSets=1`));
      expect(decodeServiceOffersResponse(await currentClient?.json()).offers).toMatchObject([
        { kind: "save", relativePath: "App/Assets.xcassets", fileCount: 11 },
      ]);
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

  describe("spend ceiling enforcement on manual generation", () => {
    const directories: Array<string> = [];
    const nowIso = "2026-08-28T12:00:00.000Z";
    const projectId = "a3000000-0000-4000-8000-000000000091";

    afterEach(() => {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("refuses a manual POST /api/image/jobs request over a thread or Project monetary ceiling without calling the provider", async () => {
      const directory = mkdtempSync(join(tmpdir(), "octant-image-routes-ceiling-"));
      directories.push(directory);
      const connection = openSqlite(join(directory, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => nowIso);
      const runtime = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: runtime.events,
        projections: runtime.projections,
        clock: () => nowIso,
      });
      const spendCeiling = new SpendCeilingService({
        connection,
        journal,
        clock: () => nowIso,
        uuid: () => crypto.randomUUID(),
        threadExists: () => true,
        projectExists: () => true,
      });
      const generate = vi.fn(async () => ({
        status: "completed" as const,
        images: [
          {
            bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
            mediaType: "image/png" as const,
          },
        ],
      }));
      const profile = imageProfile();
      const jobs = new ImageJobService({
        journal,
        projection: runtime.imageJobProjection,
        attachments: new GeneratedImageStore(directory),
        readProviderInstance: (id) => (String(id) === String(profile.id) ? profile : undefined),
        readImageGenerationCustomSources: () => [],
        credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
        uuid: () => crypto.randomUUID(),
        clock: () => nowIso,
        actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000002" as never },
        createAdapter: () => ({ generate }),
        spendCeiling,
        resolveThreadProjectId: () => projectId,
      });
      const windowAuthorityStore = new WindowAuthorityStore();
      windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
      const handler = createImageRouteHandler({
        jobs,
        listInstances: () => [profile],
        readImageGenerationSettings: () => ({ customSources: [] }),
        authorizeScope: async () => true,
        saveToProject: async () => ({ status: "refused", reason: "none" }),
        windowAuthorityStore,
        now: () => nowMs,
      });

      // Thread ceiling refuses first.
      spendCeiling.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: scopeId },
        expectedVersion: decodeAggregateVersion(0),
        policy: { costBudgetUsdCents: 2 },
        window: { kind: "lifetime" },
      });
      const threadRefused = await handler(
        request("/api/image/jobs", {
          method: "POST",
          body: {
            threadKind: "chat-thread",
            scopeId,
            profileInstanceId: profileId,
            modelId: "gpt-image-2",
            quality: "high",
            size: "1024x1024",
            prompt: "a red cube",
          },
        }),
      );
      expect(threadRefused?.status).toBe(403);
      expect(await threadRefused?.json()).toMatchObject({
        refusal: { kind: "exhausted", dimension: "monetary", scopeKind: "thread" },
      });

      // Clear thread ceiling; Project ceiling still refuses.
      spendCeiling.execute("local-window", {
        kind: "clear-spend-ceiling",
        scope: { kind: "thread", threadType: "chat-thread", threadId: scopeId },
        expectedVersion: decodeAggregateVersion(1),
      });
      spendCeiling.execute("local-window", {
        kind: "set-spend-ceiling",
        scope: { kind: "project", projectId: decodeProjectId(projectId) },
        expectedVersion: decodeAggregateVersion(0),
        policy: { costBudgetUsdCents: 2 },
        window: { kind: "calendar", period: "day", timeZone: "UTC" },
      });
      const projectRefused = await handler(
        request("/api/image/jobs", {
          method: "POST",
          body: {
            threadKind: "chat-thread",
            scopeId,
            profileInstanceId: profileId,
            modelId: "gpt-image-2",
            quality: "high",
            size: "1024x1024",
            prompt: "a red cube",
          },
        }),
      );
      expect(projectRefused?.status).toBe(403);
      expect(await projectRefused?.json()).toMatchObject({
        refusal: { kind: "exhausted", dimension: "monetary", scopeKind: "project" },
      });
      expect(generate).not.toHaveBeenCalled();
    });
  });

  describe("chunked thread artifact read cache", () => {
    const directories: Array<string> = [];
    const nowIso = "2026-08-28T12:00:00.000Z";
    const secondAttachmentId = "a3000000-0000-4000-8000-000000000011";

    afterEach(() => {
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    function makeMultiChunkPng(byteLength: number, fillSeed: number): Uint8Array {
      const header = Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      const bytes = new Uint8Array(byteLength);
      bytes.set(header, 0);
      for (let index = header.length; index < byteLength; index += 1) {
        bytes[index] = (index + fillSeed) & 0xff;
      }
      return bytes;
    }

    function completedJobWith(
      artifacts: ReadonlyArray<{
        readonly attachmentId: string;
        readonly size: number;
        readonly hash: string;
        readonly mime?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      }>,
      overrideJobId = jobId,
    ): ImageJob {
      return decodeImageJob({
        ...queuedJob(),
        id: overrideJobId,
        status: "completed",
        artifacts: artifacts.map((item) => ({
          attachmentId: item.attachmentId,
          size: item.size,
          mime: item.mime ?? "image/png",
          hash: item.hash,
          evidence: {
            jobId: overrideJobId,
            profileInstanceId: profileId,
            modelId: "gpt-image-2",
            promptHash: "a".repeat(64),
          },
        })),
      });
    }

    it("reuses verified bytes across multi-chunk thread artifact reads while serving exact slices and ranges", async () => {
      const totalBytes = THREAD_IMAGE_CHUNK_BYTES * 2 + 123;
      const imageBytes = makeMultiChunkPng(totalBytes, 7);
      const job = completedJobWith([{ attachmentId, size: totalBytes, hash: "1".repeat(64) }]);
      const readArtifact = vi.fn(async () => ({
        bytes: imageBytes,
        mime: "image/png" as const,
      }));
      const authorizeScope = vi.fn(async () => true);
      const windowAuthorityStore = new WindowAuthorityStore();
      windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
      let clockMs = nowMs;
      const handler = createImageRouteHandler({
        jobs: {
          enqueue: vi.fn(),
          cancel: vi.fn(),
          get: (id: ImageJobId) => (String(id) === String(job.id) ? job : undefined),
          listByScope: () => [job],
          readArtifact,
        } as unknown as ImageJobService,
        listInstances: () => [imageProfile()],
        readImageGenerationSettings: () => ({ customSources: [] }),
        authorizeScope,
        saveToProject: vi.fn(),
        windowAuthorityStore,
        now: () => clockMs,
      });

      try {
        const offsets = [0, THREAD_IMAGE_CHUNK_BYTES, THREAD_IMAGE_CHUNK_BYTES * 2];
        const received = new Uint8Array(totalBytes);
        for (const offset of offsets) {
          const response = await handler(
            request(
              `/api/image/thread-artifact?jobId=${jobId}&attachmentId=${attachmentId}&offset=${offset}`,
            ),
          );
          expect(response?.status).toBe(206);
          const end = Math.min(offset + THREAD_IMAGE_CHUNK_BYTES, totalBytes);
          expect(response?.headers.get("content-range")).toBe(
            `bytes ${offset}-${end - 1}/${totalBytes}`,
          );
          expect(response?.headers.get("content-type")).toBe("image/png");
          const chunk = new Uint8Array(await (response ?? Response.error()).arrayBuffer());
          expect(chunk.byteLength).toBe(end - offset);
          received.set(chunk, offset);
        }

        expect(readArtifact).toHaveBeenCalledTimes(1);
        // Every chunk still authorizes before and after the artifact lookup.
        expect(authorizeScope).toHaveBeenCalledTimes(offsets.length * 2);
        expect(Buffer.compare(received, imageBytes)).toBe(0);
      } finally {
        handler.close();
      }
    });

    it("evicts the single cached entry when another attachment is read and re-reads after TTL expiry", async () => {
      vi.useFakeTimers();
      try {
        const firstBytes = makeMultiChunkPng(128, 1);
        const secondBytes = makeMultiChunkPng(160, 2);
        const job = completedJobWith([
          { attachmentId, size: firstBytes.byteLength, hash: "1".repeat(64) },
          { attachmentId: secondAttachmentId, size: secondBytes.byteLength, hash: "2".repeat(64) },
        ]);
        const readArtifact = vi.fn(async (_jobId: ImageJobId, requestedId: ImageArtifactId) =>
          String(requestedId) === attachmentId
            ? { bytes: firstBytes, mime: "image/png" as const }
            : { bytes: secondBytes, mime: "image/png" as const },
        );
        const windowAuthorityStore = new WindowAuthorityStore();
        windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
        let clockMs = nowMs;
        const handler = createImageRouteHandler({
          jobs: {
            enqueue: vi.fn(),
            cancel: vi.fn(),
            get: (id: ImageJobId) => (String(id) === String(job.id) ? job : undefined),
            listByScope: () => [job],
            readArtifact,
          } as unknown as ImageJobService,
          listInstances: () => [imageProfile()],
          readImageGenerationSettings: () => ({ customSources: [] }),
          authorizeScope: async () => true,
          saveToProject: vi.fn(),
          windowAuthorityStore,
          now: () => clockMs,
        });

        try {
          const readChunk = (id: string) =>
            handler(
              request(`/api/image/thread-artifact?jobId=${jobId}&attachmentId=${id}&offset=0`),
            );

          expect((await readChunk(attachmentId))?.status).toBe(206);
          expect((await readChunk(attachmentId))?.status).toBe(206);
          expect(readArtifact).toHaveBeenCalledTimes(1);
          expect(vi.getTimerCount()).toBe(1);

          // Reading a second attachment evicts the first single-entry slot.
          expect((await readChunk(secondAttachmentId))?.status).toBe(206);
          expect(readArtifact).toHaveBeenCalledTimes(2);
          expect(vi.getTimerCount()).toBe(1);
          expect((await readChunk(attachmentId))?.status).toBe(206);
          expect(readArtifact).toHaveBeenCalledTimes(3);

          // Advancing past the 30s TTL auto-clears the timer/entry and forces a fresh verified read.
          clockMs += 30_000;
          await vi.advanceTimersByTimeAsync(30_000);
          expect(vi.getTimerCount()).toBe(0);
          expect((await readChunk(attachmentId))?.status).toBe(206);
          expect(readArtifact).toHaveBeenCalledTimes(4);
        } finally {
          handler.close();
          expect(vi.getTimerCount()).toBe(0);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails closed on authorization revocation, job deletion, or attachment metadata change even while bytes are cached", async () => {
      const imageBytes = makeMultiChunkPng(128, 3);
      let currentJob: ImageJob | undefined = completedJobWith([
        { attachmentId, size: imageBytes.byteLength, hash: "1".repeat(64) },
      ]);
      const readArtifact = vi.fn(async () => ({
        bytes: imageBytes,
        mime: "image/png" as const,
      }));
      const authorizeScope = vi.fn(async () => true);
      const windowAuthorityStore = new WindowAuthorityStore();
      windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
      const handler = createImageRouteHandler({
        jobs: {
          enqueue: vi.fn(),
          cancel: vi.fn(),
          get: (id: ImageJobId) =>
            currentJob !== undefined && String(id) === String(currentJob.id)
              ? currentJob
              : undefined,
          listByScope: () => (currentJob === undefined ? [] : [currentJob]),
          readArtifact,
        } as unknown as ImageJobService,
        listInstances: () => [imageProfile()],
        readImageGenerationSettings: () => ({ customSources: [] }),
        authorizeScope,
        saveToProject: vi.fn(),
        windowAuthorityStore,
        now: () => nowMs,
      });
      const path = `/api/image/thread-artifact?jobId=${jobId}&attachmentId=${attachmentId}&offset=0`;

      try {
        // Prime the cache.
        expect((await handler(request(path)))?.status).toBe(206);
        expect(readArtifact).toHaveBeenCalledTimes(1);

        // Revoking authorization before lookup fails closed without returning cached bytes.
        authorizeScope.mockResolvedValueOnce(false);
        expect((await handler(request(path)))?.status).toBe(404);
        expect(readArtifact).toHaveBeenCalledTimes(1);

        // Revoking authorization after lookup fails closed without returning cached bytes.
        authorizeScope.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect((await handler(request(path)))?.status).toBe(404);
        expect(readArtifact).toHaveBeenCalledTimes(1);

        // Changing the attachment hash invalidates the cached entry and forces a re-read.
        currentJob = completedJobWith([
          { attachmentId, size: imageBytes.byteLength, hash: "9".repeat(64) },
        ]);
        expect((await handler(request(path)))?.status).toBe(206);
        expect(readArtifact).toHaveBeenCalledTimes(2);

        // Deleting the job fails closed immediately even while bytes are cached, and evicts them.
        const savedJob = currentJob;
        currentJob = undefined;
        expect((await handler(request(path)))?.status).toBe(404);
        currentJob = savedJob;
        expect((await handler(request(path)))?.status).toBe(206);
        expect(readArtifact).toHaveBeenCalledTimes(3);
      } finally {
        handler.close();
      }
    });

    it("reads a multi-chunk generated image from disk once through ImageJobService and clears cache on close", async () => {
      const directory = mkdtempSync(join(tmpdir(), "octant-image-routes-cache-"));
      directories.push(directory);
      const connection = openSqlite(join(directory, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => nowIso);
      const runtime = createPhase1RuntimeRegistries();
      const journal = new Journal({
        connection,
        registry: runtime.events,
        projections: runtime.projections,
        clock: () => nowIso,
      });
      const totalBytes = THREAD_IMAGE_CHUNK_BYTES * 2 + 257;
      const imageBytes = makeMultiChunkPng(totalBytes, 19);
      const attachments = new GeneratedImageStore(directory);
      const readSpy = vi.spyOn(attachments, "read");
      const profile = imageProfile();
      const jobs = new ImageJobService({
        journal,
        projection: runtime.imageJobProjection,
        attachments,
        readProviderInstance: (id) => (String(id) === String(profile.id) ? profile : undefined),
        readImageGenerationCustomSources: () => [],
        credentialResolver: { has: async () => true, resolve: async () => "sk-test" },
        uuid: () => crypto.randomUUID(),
        clock: () => nowIso,
        actor: { kind: "system", actorId: "00000000-0000-4000-8000-000000000002" as never },
        createAdapter: () => ({
          generate: async () => ({
            status: "completed" as const,
            images: [{ bytes: imageBytes, mediaType: "image/png" as const }],
          }),
        }),
      });
      const queued = await jobs.enqueue({
        threadKind: "chat-thread",
        scopeId: scopeId as never,
        profileInstanceId: profile.id,
        modelId: "gpt-image-2" as never,
        prompt: "wide panorama",
      });
      const completed = await jobs.whenTerminal(queued.id);
      const stored = completed.artifacts[0];
      expect(stored).toBeDefined();
      if (stored === undefined) return;
      readSpy.mockClear();

      const windowAuthorityStore = new WindowAuthorityStore();
      windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
      const handler = createImageRouteHandler({
        jobs,
        listInstances: () => [profile],
        readImageGenerationSettings: () => ({ customSources: [] }),
        authorizeScope: async () => true,
        saveToProject: async () => ({ status: "refused", reason: "none" }),
        windowAuthorityStore,
        now: () => nowMs,
      });

      const reassembled = new Uint8Array(totalBytes);
      for (const offset of [0, THREAD_IMAGE_CHUNK_BYTES, THREAD_IMAGE_CHUNK_BYTES * 2]) {
        const response = await handler(
          request(
            `/api/image/thread-artifact?jobId=${completed.id}&attachmentId=${stored.attachmentId}&offset=${offset}`,
          ),
        );
        expect(response?.status).toBe(206);
        const chunk = new Uint8Array(await (response ?? Response.error()).arrayBuffer());
        reassembled.set(chunk, offset);
      }

      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(Buffer.compare(reassembled, imageBytes)).toBe(0);

      // Purging the scope evicts cached bytes immediately so the next read re-verifies on disk.
      handler.evictScope(completed.scopeId);
      const afterEvict = await handler(
        request(
          `/api/image/thread-artifact?jobId=${completed.id}&attachmentId=${stored.attachmentId}&offset=0`,
        ),
      );
      expect(afterEvict?.status).toBe(206);
      expect(readSpy).toHaveBeenCalledTimes(2);

      // Closing the route handler drops the cached entry and prevents re-caching.
      handler.close();
      const afterClose = await handler(
        request(
          `/api/image/thread-artifact?jobId=${completed.id}&attachmentId=${stored.attachmentId}&offset=0`,
        ),
      );
      expect(afterClose?.status).toBe(206);
      expect(readSpy).toHaveBeenCalledTimes(3);
      const secondAfterClose = await handler(
        request(
          `/api/image/thread-artifact?jobId=${completed.id}&attachmentId=${stored.attachmentId}&offset=0`,
        ),
      );
      expect(secondAfterClose?.status).toBe(206);
      expect(readSpy).toHaveBeenCalledTimes(4);
    });

    it("does not populate the cache when scope eviction races with an in-flight artifact read", async () => {
      const imageBytes = makeMultiChunkPng(128, 11);
      const job = completedJobWith([
        { attachmentId, size: imageBytes.byteLength, hash: "3".repeat(64) },
      ]);
      let releaseFirstRead: (() => void) | undefined;
      let firstReadStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        firstReadStarted = resolve;
      });
      let calls = 0;
      const readArtifact = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          firstReadStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstRead = resolve;
          });
        }
        return { bytes: imageBytes, mime: "image/png" as const };
      });
      const windowAuthorityStore = new WindowAuthorityStore();
      windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
      const handler = createImageRouteHandler({
        jobs: {
          enqueue: vi.fn(),
          cancel: vi.fn(),
          get: (id: ImageJobId) => (String(id) === String(job.id) ? job : undefined),
          listByScope: () => [job],
          readArtifact,
        } as unknown as ImageJobService,
        listInstances: () => [imageProfile()],
        readImageGenerationSettings: () => ({ customSources: [] }),
        authorizeScope: async () => true,
        saveToProject: vi.fn(),
        windowAuthorityStore,
        now: () => nowMs,
      });

      try {
        const path = `/api/image/thread-artifact?jobId=${jobId}&attachmentId=${attachmentId}&offset=0`;
        const inFlight = handler(request(path));
        await started;
        handler.evictScope(job.scopeId);
        releaseFirstRead?.();
        expect((await inFlight)?.status).toBe(206);
        // The raced read must not have populated the cache.
        expect((await handler(request(path)))?.status).toBe(206);
        expect(readArtifact).toHaveBeenCalledTimes(2);
      } finally {
        handler.close();
      }
    });
  });
});
