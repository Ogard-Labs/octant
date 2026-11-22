import { randomUUID } from "node:crypto";
import { decodeCodeRelativePath } from "@octant/contracts";
import {
  MEDIA_TOOL_CONTRIBUTION_KIND,
  type MediaToolHostPort,
  type MediaToolPluginDefinition,
} from "@octant/plugin-api/media-tools";
import {
  contributedMediaToolName,
  createContributedMediaTool,
  LOOK_MEDIA_TOOL_PLUGIN,
  LOOK_TOOL_NAME,
} from "@octant/plugin-host/media-tools";
import { describe, expect, it, vi } from "vitest";
import { adaptMediaToolSet } from "./mediaToolAdapter";

describe("adaptMediaToolSet", () => {
  it("runs a third-party media tool plugin through MediaToolHostPort and taints successful results as outside content", async () => {
    const plugin: MediaToolPluginDefinition = {
      kind: MEDIA_TOOL_CONTRIBUTION_KIND,
      id: "caption-clip",
      modes: ["work"],
      createTools: (port) => ({
        definitions: [
          {
            name: "caption",
            description: "Transcribe a clip via the host media port.",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        taintPolicy: "none",
        close: async () => undefined,
        execute: async ({ signal }) => {
          const outcome = await port.transcription?.transcribe({
            relativePath: decodeCodeRelativePath("clip.wav"),
            allowFreshRequest: true,
            ...(signal === undefined ? {} : { signal }),
          });
          return outcome?.status === "transcribed"
            ? { result: { caption: outcome.text } }
            : { result: { error: "failed" }, isError: true };
        },
      }),
    };
    const port: MediaToolHostPort = {
      turn: {
        mode: "work",
        hasFolder: true,
        unattended: false,
        inPlan: () => false,
        allowed: () => true,
      },
      transcription: {
        isAvailable: () => true,
        transcribe: async () => ({ status: "transcribed", text: "Spoken words" }),
      },
    };
    const packageId = "10000000-0000-4000-8000-000000000077";
    const contributed = createContributedMediaTool({
      packageId,
      componentId: "caption-clip",
      plugin,
      facts: { installed: true, trusted: true, enabled: true },
      port,
    });
    expect(contributed).toBeDefined();
    if (contributed === undefined) return;

    const record = vi.fn(() => ({
      kind: "recorded" as const,
      taint: { externalContentIngested: true, ingestedSources: ["plugin"] },
    }));
    const adapted = adaptMediaToolSet({
      tools: contributed,
      threadId: "thread-1",
      recordExternalContentIngestion: record,
      uuid: randomUUID,
    });
    const assignedName = contributedMediaToolName(packageId, "caption-clip");
    const outcome = await adapted.execute({ name: assignedName, inputJson: "{}" });
    expect(outcome).toMatchObject({
      result: { caption: "Spoken words" },
      outsideContent: { labels: [] },
    });
    expect(record).toHaveBeenCalledOnce();

    // Missing taint recorder fails closed for outside-content media tools.
    const unrecorded = adaptMediaToolSet({ tools: contributed });
    expect(await unrecorded.execute({ name: assignedName, inputJson: "{}" })).toMatchObject({
      isError: true,
      result: { status: "refused" },
    });
  });

  it("keeps watcher-only media tools unmarked on clean results while still running Watcher checks", async () => {
    const tools = LOOK_MEDIA_TOOL_PLUGIN.createTools({
      turn: {
        mode: "chat",
        hasFolder: false,
        unattended: false,
        inPlan: () => false,
        allowed: () => true,
      },
      imageDescription: {
        isAvailable: () => true,
        describeAttachment: async () => ({
          status: "described",
          imageName: "photo.png",
          describedBy: { model: "Vision", provider: "Anthropic" },
          description: "A wooden desk with a mug.",
        }),
        describeFolderImage: async () => ({ status: "refused", reason: "no folder" }),
      },
    });
    expect(tools).toBeDefined();
    if (tools === undefined) return;
    const record = vi.fn(() => ({
      kind: "recorded" as const,
      taint: { externalContentIngested: true, ingestedSources: [] },
    }));
    const adapted = adaptMediaToolSet({
      tools,
      threadId: "thread-2",
      recordExternalContentIngestion: record,
      uuid: randomUUID,
    });
    const outcome = await adapted.execute({
      name: LOOK_TOOL_NAME,
      inputJson: JSON.stringify({ image: "att-1" }),
    });
    expect(outcome).toEqual({
      result: {
        image: "photo.png",
        described_by: "Vision (Anthropic)",
        description: "A wooden desk with a mug.",
      },
    });
    expect(record).not.toHaveBeenCalled();
  });
});
