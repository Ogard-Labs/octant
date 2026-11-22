import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  decodeCodeRelativePath,
  decodeCodeThreadView,
  decodeImageGenerationScopeId,
  decodeProject,
  decodeProviderInstance,
  decodeProviderModelId,
  decodeWindowId,
  SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS,
  type ServiceOffer,
  type SpeechSynthesisVoice,
} from "@octant/contracts";
import { resolveSpeechEndpoint } from "@octant/domain";
import { createManagedWorktreeNodePorts } from "../code/managedWorktreeNodePorts";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import { ServiceOfferService } from "../offers/serviceOfferService";
import { applyProtectedFilesChoice, currentProtectedFilesChoice } from "../process/secretGuard";
import {
  createExistingWorktreeCodeFileRootAuthority,
  deriveExistingWorktreeCheckoutId,
} from "../wiring/code";
import { makeOpenAiCompatibleSpeechAdapter } from "./speechAdapter";
import { createSpeechGates } from "./speechGates";
import { ThreadNarration, type NarrationPosture } from "./narrationTool";

let dir = "";
let folder = "";
// Realistic MP3 bytes starting with an ID3v2 header followed by an MPEG frame sync header.
const mp3Bytes = Uint8Array.from([
  0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x00, 0x11, 0x22,
]);
const wavBytes = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
]);
const oggBytes = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "octant-narrate-")));
  folder = join(dir, "folder");
  await mkdir(folder);
});
afterEach(() => rm(dir, { force: true, recursive: true }));

function fixture(
  kind: "work-thread" | "code-thread" = "work-thread",
  options: {
    readonly audio?: Uint8Array;
    readonly posture?: NarrationPosture;
    readonly root?: () => Promise<string | undefined>;
  } = {},
) {
  const windowId = decodeWindowId(randomUUID());
  const scopeId = decodeImageGenerationScopeId(randomUUID());
  const offers = new ServiceOfferService<ServiceOffer, ServiceOfferAnswer>(8, {
    uuid: randomUUID,
    now: Date.now,
  });
  const settings: {
    allowed: boolean;
    posture: NarrationPosture;
    ready: boolean;
    voice: SpeechSynthesisVoice | undefined;
    root: string | undefined;
    address: string;
    model: string;
  } = {
    allowed: true,
    posture: options.posture ?? "allow",
    ready: true,
    voice: "alloy",
    root: folder,
    address: "http://127.0.0.1:7401/v1",
    model: "tts-1",
  };
  const toolConstraints: string[] = [];
  const audio = options.audio ?? mp3Bytes;
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(Uint8Array.from(audio), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
  );
  const service = new ThreadNarration();
  const gates = createSpeechGates();
  const tool = (thread = scopeId) =>
    service.forTurn({
      windowId,
      threadKind: kind,
      scopeId: thread,
      ...(kind === "code-thread" ? { toolConstraints: () => toolConstraints } : {}),
      posture: () => settings.posture,
      offers,
      gates,
      allowed: () => settings.allowed,
      root: options.root ?? (async () => settings.root),
      endpoint: () => {
        const instance = decodeProviderInstance({
          id: "00000000-0000-4000-8000-00000000c002",
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
        if (!settings.ready) return resolveSpeechEndpoint(undefined, [instance]);
        return resolveSpeechEndpoint(
          settings.voice === undefined
            ? { providerInstanceId: instance.id, modelId: decodeProviderModelId(settings.model) }
            : {
                providerInstanceId: instance.id,
                modelId: decodeProviderModelId(settings.model),
                voice: settings.voice,
              },
          [instance],
        );
      },
      adapter: (ready) => makeOpenAiCompatibleSpeechAdapter({ instance: ready.instance, fetch }),
    });
  const call = (args: Record<string, unknown> = {}, thread = scopeId) => {
    const t = tool(thread);
    if (!t) throw new Error("tool not offered");
    return t.execute({
      name: "octant_narrate",
      inputJson: JSON.stringify({
        text: "Welcome to the product demo.",
        relativePath: "narration/intro.mp3",
        ...args,
      }),
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
      ?.settle(cancel ? { status: "cancelled" } : { status: "narrate", rememberForThread });
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
    waiting,
    answer,
    fetch,
  };
}

it.each(["work-thread", "code-thread"] as const)(
  "synthesizes text to narration/intro.mp3 only after approval in %s",
  async (kind) => {
    const longText = "Opening narration. " + "x".repeat(340);
    const f = fixture(kind);
    const pending = f.call({ text: longText });
    expect(await f.waiting()).toMatchObject({
      kind: "narrate",
      threadKind: kind,
      excerpt: longText.slice(0, 300).trimEnd(),
      characters: longText.length,
      relativePath: "narration/intro.mp3",
      voice: "alloy",
      endpointName: "Studio",
      modelId: f.settings.model,
      format: "mp3",
    });
    expect(f.fetch).not.toHaveBeenCalled();
    await f.answer();
    expect(await pending).toEqual({
      result: {
        status: "saved",
        relativePath: "narration/intro.mp3",
        bytes: mp3Bytes.byteLength,
      },
    });
    const written = Uint8Array.from(await readFile(join(folder, "narration", "intro.mp3")));
    expect(written).toEqual(mp3Bytes);
    // Verify the file starts with an ID3 header.
    expect(Buffer.from(written.slice(0, 3)).toString("ascii")).toBe("ID3");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = f.fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(f.settings.address + "/audio/speech");
    expect(JSON.parse(String(request?.body))).toEqual({
      model: "tts-1",
      input: longText,
      voice: "alloy",
      response_format: "mp3",
    });
  },
);

it("supports wav and opus formats with matching case-insensitive extensions", async () => {
  const wavFixture = fixture("work-thread", { audio: wavBytes });
  const wavPending = wavFixture.call({ relativePath: "audio/clip.WAV", format: "wav" });
  await wavFixture.answer();
  expect(await wavPending).toEqual({
    result: { status: "saved", relativePath: "audio/clip.WAV", bytes: wavBytes.byteLength },
  });
  expect(Uint8Array.from(await readFile(join(folder, "audio", "clip.WAV")))).toEqual(wavBytes);

  const opusFixture = fixture("code-thread", { audio: oggBytes });
  const opusPending = opusFixture.call({ relativePath: "audio/voice.ogg", format: "opus" });
  await opusFixture.answer();
  expect(await opusPending).toEqual({
    result: { status: "saved", relativePath: "audio/voice.ogg", bytes: oggBytes.byteLength },
  });
  expect(Uint8Array.from(await readFile(join(folder, "audio", "voice.ogg")))).toEqual(oggBytes);
});

it("writes into a Code thread's linked git worktree rather than the main project checkout", async () => {
  const projectRoot = join(dir, "project");
  const worktreeRoot = join(dir, "worktree");
  await mkdir(projectRoot);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Initial commit",
  );
  git("worktree", "add", "-q", "-b", "narrate-branch", worktreeRoot);

  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const now = "2026-11-20T09:00:00.000Z";
  const { repository } = createManagedWorktreeNodePorts();
  const observed = await repository.observe(projectRoot, new AbortController().signal);
  if (observed.status !== "available") throw new Error("Test repository is unavailable.");
  const { repositoryId } = observed;
  const projectId = id(2);
  const bindingRevisionId = id(3);
  const checkoutId = id(4);
  const head = git("rev-parse", "HEAD");
  const view = decodeCodeThreadView({
    thread: {
      id: id(1),
      projectId,
      bindingRevisionId,
      checkoutId,
      repositoryId,
      title: "Narrate in worktree",
      lifecycle: "active",
      providerInstanceId: id(5),
      modelId: "model",
      executionPolicy: "full-access",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "narrate-branch",
        remoteName: "origin",
        proposedBaseRepository: "test/project",
        proposedBaseBranch: "main",
        outcomeKind: "local-implementation",
        confirmedAt: now,
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    checkout: {
      id: checkoutId,
      repositoryId,
      kind: "managed-worktree",
      availability: "available",
      head: { kind: "branch", name: "narrate-branch", oid: head },
      ownershipReceiptId: id(6),
      observedAt: now,
    },
    lastSequence: 1,
  });
  const project = decodeProject({
    id: projectId,
    name: "Test project",
    type: "code",
    lifecycle: "active",
    codeAccessPersistence: "current-session",
    binding: { canonicalRoot: projectRoot },
    bindingHistory: [
      {
        revisionId: bindingRevisionId,
        revision: 1,
        currentBinding: { canonicalRoot: projectRoot },
        actor: { kind: "local-user", actorId: id(7) },
        changedAt: now,
      },
    ],
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  if (project.type !== "code") throw new Error("Expected a Code Project.");
  const identity = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    return { device: String(stat.dev), inode: String(stat.ino) };
  };
  const roots = createExistingWorktreeCodeFileRootAuthority({
    projects: {
      bootstrap: async () => ({
        active: [{ ...project, bindingRevisionId: view.thread.bindingRevisionId }],
        archived: [],
        availability: [],
        memory: [],
      }),
    },
    readProject: () => project,
    repository,
    managedReceipts: {
      load: async () => ({
        version: 1,
        receiptId: id(6),
        state: "ready",
        threadId: view.thread.id,
        checkoutId,
        repositoryId,
        canonicalRepositoryPath: projectRoot,
        canonicalWorktreePath: worktreeRoot,
        branchIntent: "narrate-branch",
        refIntent: "refs/heads/narrate-branch",
        expectedHead: head,
        createdAt: now,
        updatedAt: now,
      }),
    },
    statIdentity: async (path) => identity(path),
    currentIdentity: (path) => ({ canonicalPath: realpathSync(path), ...identity(path) }),
  });

  // Derive the existing-worktree id too just to verify our checkout is genuinely managed.
  expect(
    deriveExistingWorktreeCheckoutId({
      projectId,
      bindingRevisionId,
      repositoryId,
      canonicalRoot: projectRoot,
    }),
  ).not.toBe(checkoutId);

  const windowId = decodeWindowId(id(7));
  const f = fixture("code-thread", {
    root: async () => {
      const resolved = await roots.resolve(
        windowId,
        view.thread,
        view.checkout,
        decodeCodeRelativePath("narration/intro.mp3"),
      );
      return resolved?.rootPath;
    },
  });
  const pending = f.call({ relativePath: "narration/intro.mp3" });
  await f.answer();
  expect(await pending).toEqual({
    result: { status: "saved", relativePath: "narration/intro.mp3", bytes: mp3Bytes.byteLength },
  });
  expect(existsSync(join(projectRoot, "narration", "intro.mp3"))).toBe(false);
  expect(Uint8Array.from(await readFile(join(worktreeRoot, "narration", "intro.mp3")))).toEqual(
    mp3Bytes,
  );
});

it("refuses oversized text, mismatched extensions, paths outside the folder, protected paths and existing files before asking", async () => {
  const f = fixture();
  const outsideDir = join(dir, "outside-dir");
  await mkdir(outsideDir);
  await symlink(outsideDir, join(folder, "escape-link"));
  await writeFile(join(folder, "existing.mp3"), "keep-me");
  const protectedDir = join(folder, "secrets");
  await mkdir(protectedDir);
  const previousProtected = currentProtectedFilesChoice();
  applyProtectedFilesChoice({
    ...previousProtected,
    added: [...previousProtected.added, protectedDir],
  });
  try {
    const tooLong = await f.call({
      text: "a".repeat(SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS + 1),
    });
    expect(tooLong).toEqual({
      isError: true,
      result: {
        status: "refused",
        reason:
          "Split the text into parts of at most 4,096 characters and narrate each to its own file.",
      },
    });

    for (const args of [
      { text: "   " },
      { relativePath: "wrong.wav", format: "mp3" },
      { relativePath: "wrong.mp3", format: "wav" },
      { relativePath: "wrong.opus", format: "opus" },
      { relativePath: "../outside.mp3" },
      { relativePath: join(dir, "outside.mp3") },
      { relativePath: "C:/Windows/out.mp3" },
      { relativePath: "escape-link/out.mp3" },
      { relativePath: "secrets/narration.mp3" },
      { relativePath: "existing.mp3" },
    ]) {
      expect(await f.call(args)).toMatchObject({ isError: true, result: { status: "refused" } });
    }
    expect(f.offers.listForWindow(f.windowId)).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await readFile(join(folder, "existing.mp3"), "utf8")).toBe("keep-me");
  } finally {
    applyProtectedFilesChoice(previousProtected);
  }
});

it("withholds narration when synthesis is unconfigured, lacks a voice, is in Plan, or is excluded by Code toolConstraints", async () => {
  const f = fixture("code-thread");

  f.settings.ready = false;
  expect(f.tool()).toBeUndefined();
  f.settings.ready = true;

  f.settings.voice = undefined;
  expect(f.tool()).toBeUndefined();
  f.settings.voice = "alloy";

  f.settings.posture = "refuse";
  expect(f.tool()).toBeUndefined();
  f.settings.posture = "allow";

  f.toolConstraints.push("octant_canvas");
  expect(f.tool()).toBeUndefined();
  f.toolConstraints.push("octant_narrate");

  const t = f.tool();
  if (!t) throw new Error("expected tool");
  f.settings.posture = "refuse";
  expect(
    await t.execute({
      name: "octant_narrate",
      inputJson: JSON.stringify({ text: "Hello", relativePath: "plan.mp3" }),
    }),
  ).toMatchObject({ isError: true, result: { status: "refused" } });
  expect(f.offers.listForWindow(f.windowId)).toEqual([]);
  expect(f.fetch).not.toHaveBeenCalled();

  f.settings.posture = "allow";
  const pending = f.call({ relativePath: "constrained.mp3" });
  await f.waiting();
  f.toolConstraints.pop();
  await f.answer(true);
  expect((await pending).isError).toBe(true);
  expect(f.fetch).not.toHaveBeenCalled();
});

it("skips the card for a remembered thread at Accept edits or Full access, but always asks at Ask first", async () => {
  const f = fixture("work-thread", { posture: "allow" });
  const first = f.call({ relativePath: "part1.mp3" });
  await f.answer(true);
  expect(await first).toEqual({
    result: { status: "saved", relativePath: "part1.mp3", bytes: mp3Bytes.byteLength },
  });

  // At Accept edits / Full access ("allow"), remembered thread writes without a card.
  expect(await f.call({ relativePath: "part2.mp3" })).toEqual({
    result: { status: "saved", relativePath: "part2.mp3", bytes: mp3Bytes.byteLength },
  });
  expect(f.offers.listForWindow(f.windowId)).toEqual([]);
  expect(f.fetch).toHaveBeenCalledTimes(2);

  // Switching to Ask first / Work Auto ("ask") still shows the card even though the thread was remembered.
  f.settings.posture = "ask";
  const third = f.call({ relativePath: "part3.mp3" });
  expect(await f.waiting()).toMatchObject({ kind: "narrate", relativePath: "part3.mp3" });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  await f.answer(false);
  expect(await third).toEqual({
    result: { status: "saved", relativePath: "part3.mp3", bytes: mp3Bytes.byteLength },
  });
  expect(f.fetch).toHaveBeenCalledTimes(3);
});

it.each(["address", "model", "voice", "thread"] as const)(
  "remembers consent only within the approved thread, endpoint, model and voice: %s",
  async (change) => {
    const f = fixture();
    const first = f.call({ relativePath: "one.mp3" });
    await f.answer(true);
    await first;
    expect((await f.call({ relativePath: "two.mp3" })).result).toMatchObject({ status: "saved" });
    if (change === "address") f.settings.address = "http://127.0.0.1:7402/v1";
    if (change === "model") f.settings.model = "tts-1-hd";
    if (change === "voice") f.settings.voice = "nova";
    const next = f.call(
      { relativePath: "three.mp3" },
      change === "thread" ? decodeImageGenerationScopeId(randomUUID()) : f.scopeId,
    );
    await f.answer(false, true);
    expect((await next).isError).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(existsSync(join(folder, "three.mp3"))).toBe(false);
  },
);

it.each(["destination", "model", "voice", "access", "folder", "plan", "file", "stopped"] as const)(
  "synthesizes and writes nothing when %s changes while the offer waits",
  async (change) => {
    const f = fixture();
    const t = f.tool();
    if (!t) throw new Error("expected tool");
    const pending = t.execute({
      name: "octant_narrate",
      inputJson: JSON.stringify({ text: "Hello", relativePath: "out.mp3" }),
    });
    await f.waiting();
    if (change === "destination") f.settings.address += "/other";
    if (change === "model") f.settings.model = "replacement";
    if (change === "voice") f.settings.voice = "shimmer";
    if (change === "access") f.settings.allowed = false;
    if (change === "folder") f.settings.root = dir;
    if (change === "plan") f.settings.posture = "refuse";
    if (change === "file") await writeFile(join(folder, "out.mp3"), "appeared");
    if (change === "stopped") await t.close?.();
    else await f.answer(true);
    expect((await pending).isError).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
    if (change !== "file") expect(existsSync(join(folder, "out.mp3"))).toBe(false);
    else expect(await readFile(join(folder, "out.mp3"), "utf8")).toBe("appeared");
  },
);

it("writes nothing when access or posture is lost while synthesis is in flight", async () => {
  const f = fixture("work-thread", { posture: "allow" });
  const first = f.call({ relativePath: "seed.mp3" });
  await f.answer(true);
  await first;

  f.fetch.mockImplementationOnce(async () => {
    // Thread downgrades to Ask first while an uncarded remembered call is in flight.
    f.settings.posture = "ask";
    return new Response(Uint8Array.from(mp3Bytes), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  });
  expect(await f.call({ relativePath: "downgraded.mp3" })).toMatchObject({
    isError: true,
    result: { status: "refused" },
  });
  expect(existsSync(join(folder, "downgraded.mp3"))).toBe(false);
});

it("shares the synthesis concurrency gate, leaves a slot for local read-aloud, and reports provider failures", async () => {
  const f = fixture();
  const shared = f.gates.synthesis.tryAcquire("shared");
  const busyCall = f.call({ relativePath: "busy.mp3" });
  await f.answer();
  expect((await busyCall).result).toMatchObject({ status: "busy" });
  expect(f.fetch).not.toHaveBeenCalled();
  shared?.();

  // While agent synthesis is running in the shared slot, local read-aloud can still acquire a slot.
  let localAcquired = false;
  f.fetch.mockImplementationOnce(async () => {
    const local = f.gates.synthesis.tryAcquire("local");
    localAcquired = local !== null;
    local?.();
    return new Response(Uint8Array.from(mp3Bytes), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  });
  const okCall = f.call({ relativePath: "ok.mp3" });
  await f.answer();
  expect((await okCall).result).toMatchObject({ status: "saved" });
  expect(localAcquired).toBe(true);

  f.fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
  const failed = f.call({ relativePath: "failed.mp3" });
  await f.answer();
  expect((await failed).result).toMatchObject({ status: "failed", reason: expect.any(String) });
  expect(existsSync(join(folder, "failed.mp3"))).toBe(false);
});

it.each(["archive", "window"] as const)(
  "forgets remembered narration approval on a thread archive or window revocation: %s",
  async (loss) => {
    const f = fixture();
    const first = f.call({ relativePath: "a.mp3" });
    await f.answer(true);
    await first;
    if (loss === "archive") f.service.forget(String(f.scopeId));
    else f.service.revokeWindow(f.windowId);
    const again = f.call({ relativePath: "b.mp3" });
    await f.answer(false, true);
    expect((await again).isError).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(existsSync(join(folder, "b.mp3"))).toBe(false);
  },
);
