import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MAX_PROVIDER_TOOL_RESULT_BYTES,
  decodeImageGenerationScopeId,
  decodeProviderInstance,
  decodeProviderModelId,
  decodeWindowId,
  SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES,
  type ServiceOffer,
} from "@octant/contracts";
import { resolveSpeechEndpoint } from "@octant/domain";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import { ServiceOfferService } from "../offers/serviceOfferService";
import { makeOpenAiCompatibleSpeechAdapter } from "./speechAdapter";
import { createSpeechGates } from "./speechGates";
import { ThreadTranscription } from "./transcriptionTool";

let dir = "";
let folder = "";
const audio = Buffer.alloc(2 * 1024 * 1024);
audio.write("ftypM4A ", 4);
const path = "recording.m4a";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "octant-speech-"));
  folder = join(dir, "folder");
  await mkdir(folder);
  await writeFile(join(folder, path), audio);
});
afterEach(() => rm(dir, { force: true, recursive: true }));

function fixture(
  kind: "work-thread" | "code-thread" = "work-thread",
  transcript = "abcdefghij".repeat(10_000),
) {
  const windowId = decodeWindowId(randomUUID());
  const scopeId = decodeImageGenerationScopeId(randomUUID());
  const offers = new ServiceOfferService<ServiceOffer, ServiceOfferAnswer>(8, {
    uuid: randomUUID,
    now: Date.now,
  });
  const settings = {
    allowed: true,
    inPlan: false,
    ready: true,
    root: folder,
    address: "http://127.0.0.1:7401/v1",
    model: "meeting-model",
  };
  const toolConstraints: string[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ text: transcript }),
  );
  const record = vi.fn(() => ({
    kind: "recorded" as const,
    taint: { externalContentIngested: true, ingestedSources: ["octant_transcribe"] },
  }));
  const service = new ThreadTranscription();
  const gates = createSpeechGates();
  const tool = (thread = scopeId) =>
    service.forTurn({
      windowId,
      threadKind: kind,
      scopeId: thread,
      ...(kind === "code-thread" ? { toolConstraints: () => toolConstraints } : {}),
      inPlan: () => settings.inPlan,
      offers,
      gates,
      allowed: () => settings.allowed,
      root: async () => settings.root,
      uuid: randomUUID,
      recordExternalContentIngestion: record,
      endpoint: () => {
        const instance = decodeProviderInstance({
          id: "00000000-0000-4000-8000-00000000c001",
          displayName: "Studio",
          driverKind: "openai-compatible",
          configuration: {
            kind: "openai-compatible-http",
            baseUrl: settings.address,
            authentication: "none",
            protocol: "auto",
            manualModelIds: [],
          },
          enabled: true,
          environmentPolicy: "inherit-host",
          version: 1,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        });
        return resolveSpeechEndpoint(
          settings.ready
            ? { providerInstanceId: instance.id, modelId: decodeProviderModelId(settings.model) }
            : undefined,
          [instance],
        );
      },
      adapter: (ready) => makeOpenAiCompatibleSpeechAdapter({ instance: ready.instance, fetch }),
    });
  const call = (args: Record<string, unknown> = {}, thread = scopeId) => {
    const t = tool(thread);
    if (!t) throw new Error("tool not offered");
    return t.execute({
      name: "octant_transcribe",
      inputJson: JSON.stringify({ relativePath: path, language: "nb", ...args }),
    });
  };
  const waiting = async () => {
    await vi.waitFor(() => expect(offers.listForWindow(windowId)).toHaveLength(1));
    const [view] = offers.listForWindow(windowId);
    if (!view) throw new Error("no pending offer");
    return view;
  };
  const answer = async (rememberForThread = false, cancel = false) => {
    const view = await waiting();
    offers
      .claim(windowId, view.offerId)
      ?.settle(cancel ? { status: "cancelled" } : { status: "transcribe", rememberForThread });
  };
  return {
    windowId,
    scopeId,
    settings,
    toolConstraints,
    offers,
    gates,
    service,
    tool,
    call,
    record,
    waiting,
    answer,
    fetch,
    transcript,
  };
}

it.each(["work-thread", "code-thread"] as const)(
  "transcribes a confined recording only after approval and pages it without a second charge in %s",
  async (kind) => {
    const f = fixture(kind);
    const pending = f.call();
    expect(await f.waiting()).toMatchObject({
      kind: "transcribe",
      threadKind: kind,
      relativePath: path,
      sizeBytes: audio.length,
      endpointName: "Studio",
      modelId: f.settings.model,
    });
    expect(f.fetch).not.toHaveBeenCalled();
    await f.answer();
    const offsets = [0, 32_000, 64_000, 96_000];
    for (const offset of offsets) {
      const { result, outsideContent } = offset === 0 ? await pending : await f.call({ offset });
      expect(result).toEqual({
        status: "transcribed",
        characters: 100_000,
        text: f.transcript.slice(offset, offset + 32_000),
        truncated: offset < 96_000,
        ...(offset < 96_000 ? { nextOffset: offset + 32_000 } : {}),
      });
      expect(outsideContent).toBeDefined();
    }
    expect(f.record).toHaveBeenCalledTimes(4);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = f.fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(f.settings.address + "/audio/transcriptions");
    const form = request?.body;
    if (!(form instanceof FormData)) throw new Error("expected a multipart request");
    expect(form.get("file")).toMatchObject({ size: audio.length, type: "audio/mp4" });
    expect(form.get("language")).toBe("nb");
  },
);

it("withholds transcription under a restricted Code profile and rechecks it after approval", async () => {
  const f = fixture("code-thread");
  f.toolConstraints.push("octant_canvas");
  expect(f.tool()).toBeUndefined();
  f.toolConstraints.push("octant_transcribe");
  const pending = f.call();
  await f.waiting();
  f.toolConstraints.pop();
  await f.answer(true);
  expect((await pending).isError).toBe(true);
  expect(f.fetch).not.toHaveBeenCalled();
});

it("delivers every page of multilingual and escaped text within the Code answer limit", async () => {
  const text = ("字".repeat(3) + "\u0001𐍈").repeat(16_000);
  const f = fixture("code-thread", text);
  let pending = f.call();
  await f.answer();
  let received = "";
  for (;;) {
    const { result } = await pending;
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      MAX_PROVIDER_TOOL_RESULT_BYTES,
    );
    if (
      !result ||
      typeof result !== "object" ||
      !("text" in result) ||
      typeof result.text !== "string"
    )
      throw new Error("Expected a transcript page");
    expect(result.text).not.toMatch(/[\uD800-\uDBFF]$/u);
    received += result.text;
    if (!("nextOffset" in result)) break;
    expect(result.nextOffset).toBe(received.length);
    pending = f.call({ offset: result.nextOffset });
  }
  expect(received).toBe(text);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it.each(["address", "model", "thread"] as const)(
  "remembers consent only within the approved destination and thread: %s",
  async (change) => {
    const f = fixture();
    const pending = f.call();
    await f.answer(true);
    await pending;
    const changed = Buffer.from(audio);
    changed[100] = 1;
    await writeFile(join(folder, path), changed);
    expect((await f.call()).result).toMatchObject({ status: "transcribed" });
    if (change === "model") f.settings.model = "new-model";
    if (change === "address") f.settings.address = "http://127.0.0.1:7402/v1";
    const next = f.call(
      {},
      change === "thread" ? decodeImageGenerationScopeId(randomUUID()) : f.scopeId,
    );
    await f.answer(false, true);
    expect((await next).isError).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  },
);

it.each(["destination", "model", "access", "folder", "file", "stopped"] as const)(
  "sends nothing when %s changes while the offer waits",
  async (change) => {
    const f = fixture();
    const t = f.tool();
    if (!t) throw new Error("expected tool");
    const pending = t.execute({
      name: "octant_transcribe",
      inputJson: JSON.stringify({ relativePath: path }),
    });
    await f.waiting();
    if (change === "destination") f.settings.address += "/other";
    if (change === "model") f.settings.model = "replacement";
    if (change === "access") f.settings.allowed = false;
    if (change === "folder") f.settings.root = dir;
    if (change === "file") await writeFile(join(folder, path), Buffer.from("OggS different audio"));
    if (change === "stopped") await t.close?.();
    else await f.answer(true);
    expect((await pending).isError).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  },
);

it("refuses unsupported, oversized and out-of-folder reads before asking, and hides an unconfigured endpoint", async () => {
  const f = fixture();
  await writeFile(join(dir, "outside"), audio);
  await symlink(join(dir, "outside"), join(folder, "link"));
  await writeFile(join(folder, "text"), "this is not a recording");
  await writeFile(join(folder, "long"), Buffer.alloc(SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES + 1));
  for (const relativePath of [
    "../outside",
    join(dir, "outside"),
    "link",
    "text",
    "long",
    "C:/Windows/file.wav",
  ]) {
    const result = await f.call({ relativePath });
    expect(result).toMatchObject({
      isError: true,
      result: {
        status: "refused",
        reason: relativePath === "long" ? expect.stringMatching(/split/) : expect.any(String),
      },
    });
  }
  expect(f.offers.listForWindow(f.windowId)).toEqual([]);
  expect(f.fetch).not.toHaveBeenCalled();
  f.settings.ready = false;
  expect(f.tool()).toBeUndefined();
});

it("refuses a busy shared slot and preserves a provider failure without marking the thread", async () => {
  const f = fixture();
  const release = f.gates.transcription.tryAcquire("shared");
  const pending = f.call();
  await f.answer();
  expect((await pending).result).toMatchObject({ status: "busy" });
  expect(f.fetch).not.toHaveBeenCalled();
  release?.();
  f.fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
  const again = f.call();
  await f.answer();
  expect((await again).result).toMatchObject({ status: "failed", reason: expect.any(String) });
  expect(f.record).not.toHaveBeenCalled();
});

it("withholds the tool in Plan and refuses an already offered tool after switching to Plan", async () => {
  const f = fixture("code-thread");
  const tool = f.tool();
  if (!tool) throw new Error("expected tool");
  f.settings.inPlan = true;
  expect(f.tool()).toBeUndefined();
  expect(
    await tool.execute({
      name: "octant_transcribe",
      inputJson: JSON.stringify({ relativePath: path }),
    }),
  ).toMatchObject({ isError: true, result: { status: "refused" } });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.offers.listForWindow(f.windowId)).toEqual([]);
});

it.each(["archive", "window"] as const)(
  "forgets pages and approval on a thread or window revocation: %s",
  async (loss) => {
    const f = fixture();
    const first = f.call();
    await f.answer(true);
    await first;
    if (loss === "archive") f.service.forget(String(f.scopeId));
    else f.service.revokeWindow(f.windowId);
    expect((await f.call({ offset: 32_000 })).result).toMatchObject({ status: "refused" });
    const again = f.call();
    await f.answer(false, true);
    await again;
    expect(f.fetch).toHaveBeenCalledTimes(1);
  },
);

it("evicts the oldest of eight transcripts and never charges for a missing continuation", async () => {
  const f = fixture();
  const first = f.call();
  await f.answer(true);
  await first;
  for (let i = 1; i <= 8; i++) {
    await writeFile(join(folder, path), Buffer.from("fLaC recording " + String(i)));
    expect((await f.call()).result).toMatchObject({ status: "transcribed" });
  }
  await writeFile(join(folder, path), audio);
  expect((await f.call({ offset: 32_000 })).result).toMatchObject({ status: "refused" });
  expect(f.fetch).toHaveBeenCalledTimes(9);
});
