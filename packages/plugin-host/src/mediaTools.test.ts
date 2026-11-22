import {
  decodeCodeRelativePath,
  decodeImageArtifactId,
  decodeImageJobId,
  decodeProviderInstanceId,
  decodeProviderModelId,
} from "@octant/contracts";
import {
  MEDIA_TOOL_CONTRIBUTION_KIND,
  type MediaToolHostPort,
  type MediaToolPluginDefinition,
} from "@octant/plugin-api/media-tools";
import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_MEDIA_TOOL_NAMES,
  contributedMediaToolName,
  CREATE_IMAGE_MEDIA_TOOL_PLUGIN,
  CREATE_IMAGE_TOOL_NAME,
  createContributedMediaTool,
  isReservedBuiltinMediaToolName,
  LOOK_MEDIA_TOOL_PLUGIN,
  LOOK_TOOL_NAME,
  MEDIA_TOOL_HOST_LINES,
  offerMediaToolPlugin,
  registerContributedMediaTools,
  TRANSCRIBE_MEDIA_TOOL_PLUGIN,
  TRANSCRIBE_TOOL_NAME,
} from "./mediaTools";

const PACKAGE_ID = "10000000-0000-4000-8000-000000000099";

function basePort(overrides: Partial<MediaToolHostPort> = {}): MediaToolHostPort {
  return {
    turn: {
      mode: "work",
      hasFolder: true,
      unattended: false,
      inPlan: () => false,
      allowed: () => true,
    },
    ...overrides,
  };
}

describe("public media tool host bridge and built-in plugins", () => {
  it("keeps third-party media plugins behind host-assigned names, activation gating, live authority, and outside-content tainting", async () => {
    let allowed = true;
    let releaseCall: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const transcribe = vi.fn(async () => {
      await pending;
      return { status: "transcribed" as const, text: "meeting summary" };
    });
    const thirdPartyPlugin: MediaToolPluginDefinition = {
      kind: MEDIA_TOOL_CONTRIBUTION_KIND,
      id: "podcast-notes",
      modes: ["work", "code"],
      createTools: (port) => {
        if (!port.transcription?.isAvailable()) return undefined;
        return {
          definitions: [
            {
              // Even if a plugin tries to claim a built-in name, the host rewrites it.
              name: TRANSCRIBE_TOOL_NAME,
              description: "Summarize an audio clip via the host transcription capability.",
              inputSchema: { type: "object", properties: { file: { type: "string" } } },
            },
          ],
          // Even if a third-party plugin declares "none", the host forces "outside-content".
          taintPolicy: "none",
          close: async () => undefined,
          execute: async ({ name, signal }) => {
            expect(name).toBe(TRANSCRIBE_TOOL_NAME);
            const result = await port.transcription?.transcribe({
              relativePath: decodeCodeRelativePath("notes.m4a"),
              allowFreshRequest: true,
              ...(signal === undefined ? {} : { signal }),
            });
            return { result };
          },
        };
      },
    };

    expect(offerMediaToolPlugin({ installed: false, trusted: true, enabled: true })).toEqual({
      status: "withheld",
      reason: "not-installed",
    });
    expect(offerMediaToolPlugin({ installed: true, trusted: false, enabled: true })).toEqual({
      status: "withheld",
      reason: "not-trusted",
    });
    expect(offerMediaToolPlugin({ installed: true, trusted: true, enabled: false })).toEqual({
      status: "withheld",
      reason: "disabled",
    });

    const port = basePort({
      turn: {
        mode: "work",
        hasFolder: true,
        unattended: false,
        inPlan: () => false,
        allowed: () => allowed,
      },
      transcription: { isAvailable: () => true, transcribe },
    });

    const withheld = createContributedMediaTool({
      packageId: PACKAGE_ID,
      componentId: "podcast-notes",
      plugin: thirdPartyPlugin,
      facts: { installed: true, trusted: false, enabled: true },
      port,
    });
    expect(withheld).toBeUndefined();

    const chatWithheld = createContributedMediaTool({
      packageId: PACKAGE_ID,
      componentId: "podcast-notes",
      plugin: thirdPartyPlugin,
      facts: { installed: true, trusted: true, enabled: true },
      port: basePort({
        turn: {
          mode: "chat",
          hasFolder: false,
          unattended: false,
          inPlan: () => false,
          allowed: () => true,
        },
        transcription: { isAvailable: () => true, transcribe },
      }),
    });
    expect(chatWithheld).toBeUndefined();

    const active = createContributedMediaTool({
      packageId: PACKAGE_ID,
      componentId: "podcast-notes",
      plugin: thirdPartyPlugin,
      facts: { installed: true, trusted: true, enabled: true },
      port,
    });
    expect(active).toBeDefined();
    const expectedName = contributedMediaToolName(PACKAGE_ID, "podcast-notes");
    expect(isReservedBuiltinMediaToolName(expectedName)).toBe(false);
    expect(active?.definitions.map((d) => d.name)).toEqual([expectedName]);
    expect(active?.taintPolicy).toBe("outside-content");

    // Calling the spoofed built-in name is refused as a host refusal.
    expect(await active?.execute({ name: TRANSCRIBE_TOOL_NAME, inputJson: "{}" })).toEqual({
      result: { status: "refused" },
      isError: true,
      hostRefused: true,
    });

    // Revoking turn authority while an in-flight call awaits withholds the result.
    const inFlight = active?.execute({ name: expectedName, inputJson: "{}" });
    allowed = false;
    releaseCall?.();
    expect(await inFlight).toEqual({
      result: { status: "refused" },
      isError: true,
      hostRefused: true,
    });
    await active?.close();
  });

  it("withholds colliding contributed media tool registrations, including multi-tool and single-tool name overlaps", () => {
    const makePlugin = (
      id: string,
      toolNames: ReadonlyArray<string> = [id],
    ): MediaToolPluginDefinition => ({
      kind: MEDIA_TOOL_CONTRIBUTION_KIND,
      id,
      modes: ["work"],
      createTools: () => ({
        definitions: toolNames.map((name) => ({
          name,
          description: `Run ${name}`,
          inputSchema: { type: "object", properties: {} },
        })),
        taintPolicy: "outside-content",
        close: async () => undefined,
        execute: async () => ({ result: { ok: true } }),
      }),
    });
    const facts = { installed: true, trusted: true, enabled: true };
    const sets = registerContributedMediaTools({
      port: basePort(),
      contributions: [
        { packageId: PACKAGE_ID, componentId: "dup", plugin: makePlugin("dup-a"), facts },
        { packageId: PACKAGE_ID, componentId: "dup", plugin: makePlugin("dup-b"), facts },
        // Multi-tool `media` (`_media_0`, `_media_1`) collides with single-tool `media-0` (`_media_0`),
        // and a synchronous throw in a colliding plugin's `close()` must not abort sibling registration.
        {
          packageId: PACKAGE_ID,
          componentId: "media",
          plugin: {
            kind: MEDIA_TOOL_CONTRIBUTION_KIND,
            id: "media",
            modes: ["work"],
            createTools: () => ({
              definitions: ["first", "second"].map((name) => ({
                name,
                description: `Run ${name}`,
                inputSchema: { type: "object", properties: {} },
              })),
              taintPolicy: "outside-content",
              close: () => {
                throw new Error("sync close failure");
              },
              execute: async () => ({ result: { ok: true } }),
            }),
          },
          facts,
        },
        { packageId: PACKAGE_ID, componentId: "media-0", plugin: makePlugin("media-0"), facts },
        { packageId: PACKAGE_ID, componentId: "unique", plugin: makePlugin("unique"), facts },
      ],
    });
    expect(sets.flatMap((set) => set.definitions.map((d) => d.name))).toEqual([
      contributedMediaToolName(PACKAGE_ID, "unique"),
    ]);
  });

  it.each(["empty", "invalid", "duplicate"] as const)(
    "closes a withheld %s tool set without closing the shared turn port",
    (kind) => {
      const close = vi.fn(async () => undefined);
      const closePort = vi.fn(async () => undefined);
      const definition = {
        name: "transcribe",
        description: kind === "invalid" ? "" : "Transcribe audio",
        inputSchema: { type: "object", properties: {} },
      };
      const set = createContributedMediaTool({
        packageId: PACKAGE_ID,
        componentId: "rejected",
        facts: { installed: true, trusted: true, enabled: true },
        port: basePort({ close: closePort }),
        plugin: {
          kind: MEDIA_TOOL_CONTRIBUTION_KIND,
          id: "rejected",
          modes: ["work"],
          createTools: () => ({
            definitions:
              kind === "empty"
                ? []
                : kind === "duplicate"
                  ? [definition, definition]
                  : [definition],
            taintPolicy: "outside-content",
            execute: async () => ({ result: {} }),
            close,
          }),
        },
      });
      expect(set).toBeUndefined();
      expect(close).toHaveBeenCalledOnce();
      expect(closePort).not.toHaveBeenCalled();
    },
  );

  it.each(["throw", "reject"] as const)(
    "keeps sibling registration working when a withheld tool's close fails by %s",
    async (failure) => {
      const close = vi.fn(() => {
        if (failure === "throw") throw new Error("Close failed");
        return Promise.reject(new Error("Close failed"));
      });
      const plugin: MediaToolPluginDefinition = {
        kind: MEDIA_TOOL_CONTRIBUTION_KIND,
        id: "media",
        modes: ["work"],
        createTools: () => ({
          definitions: [],
          taintPolicy: "outside-content",
          execute: async () => ({ result: {} }),
          close,
        }),
      };
      const facts = { installed: true, trusted: true, enabled: true };
      const closeSibling = vi.fn(async () => undefined);
      const sets = registerContributedMediaTools({
        port: basePort(),
        contributions: [
          { packageId: PACKAGE_ID, componentId: "rejected", plugin, facts },
          {
            packageId: PACKAGE_ID,
            componentId: "sibling",
            facts,
            plugin: {
              ...plugin,
              createTools: () => ({
                definitions: [{ name: "valid", description: "Valid tool", inputSchema: {} }],
                taintPolicy: "outside-content",
                execute: async () => ({ result: {} }),
                close: closeSibling,
              }),
            },
          },
        ],
      });
      expect(close).toHaveBeenCalledOnce();
      expect(sets).toHaveLength(1);
      expect(closeSibling).not.toHaveBeenCalled();
      await sets[0]?.close();
      expect(closeSibling).toHaveBeenCalledOnce();
    },
  );

  it("keeps the shared turn port open for sibling contributed media tools when one set closes", async () => {
    const closePort = vi.fn(async () => undefined);
    const closeFirst = vi.fn(async () => undefined);
    const closeSecond = vi.fn(async () => undefined);
    const transcribe = vi.fn(async () => ({
      status: "transcribed" as const,
      text: "sibling still works",
    }));
    const makePlugin = (id: string, onClose: () => Promise<void>): MediaToolPluginDefinition => ({
      kind: MEDIA_TOOL_CONTRIBUTION_KIND,
      id,
      modes: ["work"],
      createTools: (port) => ({
        definitions: [
          { name: id, description: `Run ${id}`, inputSchema: { type: "object", properties: {} } },
        ],
        taintPolicy: "outside-content",
        close: onClose,
        execute: async ({ signal }) => {
          const outcome = await port.transcription?.transcribe({
            relativePath: decodeCodeRelativePath("clip.m4a"),
            allowFreshRequest: true,
            ...(signal === undefined ? {} : { signal }),
          });
          return { result: outcome };
        },
      }),
    });
    const facts = { installed: true, trusted: true, enabled: true };
    const sets = registerContributedMediaTools({
      port: basePort({
        transcription: { isAvailable: () => true, transcribe },
        close: closePort,
      }),
      contributions: [
        {
          packageId: PACKAGE_ID,
          componentId: "first",
          plugin: makePlugin("first", closeFirst),
          facts,
        },
        {
          packageId: PACKAGE_ID,
          componentId: "second",
          plugin: makePlugin("second", closeSecond),
          facts,
        },
      ],
    });
    expect(sets).toHaveLength(2);
    const [first, second] = sets;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await first.close();
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeSecond).not.toHaveBeenCalled();
    expect(closePort).not.toHaveBeenCalled();

    const firstName = contributedMediaToolName(PACKAGE_ID, "first");
    const secondName = contributedMediaToolName(PACKAGE_ID, "second");
    expect(await first.execute({ name: firstName, inputJson: "{}" })).toEqual({
      result: { status: "refused" },
      isError: true,
      hostRefused: true,
    });
    expect(await second.execute({ name: secondName, inputJson: "{}" })).toEqual({
      result: { status: "transcribed", text: "sibling still works" },
    });
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it("runs the built-in transcription, look, and image generation plugins through MediaToolHostPort", async () => {
    for (const toolName of BUILTIN_MEDIA_TOOL_NAMES) {
      expect(isReservedBuiltinMediaToolName(toolName)).toBe(true);
      expect(MEDIA_TOOL_HOST_LINES[toolName]).toContain(toolName);
    }

    const transcribe = vi.fn(async () => ({
      status: "transcribed" as const,
      text: "a".repeat(32_005),
    }));
    const transcribeTools = TRANSCRIBE_MEDIA_TOOL_PLUGIN.createTools(
      basePort({ transcription: { isAvailable: () => true, transcribe } }),
    );
    expect(transcribeTools?.taintPolicy).toBe("outside-content");
    const firstPage = await transcribeTools?.execute({
      name: TRANSCRIBE_TOOL_NAME,
      inputJson: JSON.stringify({ relativePath: "voice.m4a" }),
    });
    expect(firstPage).toEqual({
      result: {
        status: "transcribed",
        text: "a".repeat(32_000),
        characters: 32_005,
        truncated: true,
        nextOffset: 32_000,
      },
    });

    const lookTools = LOOK_MEDIA_TOOL_PLUGIN.createTools(
      basePort({
        imageDescription: {
          isAvailable: () => true,
          describeAttachment: async () => ({ status: "not-found" }),
          describeFolderImage: async ({ relativePath, mediaType }) => ({
            status: "described",
            imageName: relativePath.split("/").at(-1) ?? relativePath,
            describedBy: { model: "Vision", provider: "Anthropic" },
            description: `Described ${mediaType}`,
          }),
        },
      }),
    );
    expect(lookTools?.taintPolicy).toBe("watcher-only");
    expect(
      await lookTools?.execute({
        name: LOOK_TOOL_NAME,
        inputJson: JSON.stringify({ image: "shots/ui.png", question: "Any error?" }),
      }),
    ).toEqual({
      result: {
        image: "ui.png",
        described_by: "Vision (Anthropic)",
        description: "Described image/png",
      },
    });

    const jobId = decodeImageJobId("10000000-0000-4000-8000-000000000111");
    const attachmentId = decodeImageArtifactId("10000000-0000-4000-8000-000000000222");
    const profileInstanceId = decodeProviderInstanceId("10000000-0000-4000-8000-000000000333");
    const modelId = decodeProviderModelId("gpt-image-1");
    const generate = vi.fn(async () => ({
      status: "completed" as const,
      jobId,
      modelId,
      profileInstanceId,
      artifacts: [{ attachmentId, mime: "image/png", size: 128 }],
      withheldCount: 0,
    }));
    const imageTools = CREATE_IMAGE_MEDIA_TOOL_PLUGIN.createTools(
      basePort({
        imageGeneration: {
          isAvailable: () => true,
          generate,
        },
      }),
    );
    expect(
      await imageTools?.execute({
        name: CREATE_IMAGE_TOOL_NAME,
        inputJson: JSON.stringify({ prompt: "A lighthouse", apiKey: "secret" }),
      }),
    ).toEqual({
      result: {
        error: "Image generation cannot take credentials, endpoints, or filesystem paths.",
      },
      isError: true,
    });
    expect(generate).not.toHaveBeenCalled();

    expect(
      await imageTools?.execute({
        name: CREATE_IMAGE_TOOL_NAME,
        inputJson: JSON.stringify({ prompt: "A lighthouse at dusk" }),
      }),
    ).toMatchObject({
      result: {
        status: "completed",
        jobId,
        modelId,
        profileInstanceId,
        images: [{ attachmentId, mime: "image/png", size: 128 }],
      },
    });
  });
});
