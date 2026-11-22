import { decodeCodeRelativePath } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  MEDIA_DESCRIBABLE_IMAGE_TYPES,
  MEDIA_TOOL_CONTRIBUTION_KIND,
  type MediaToolHostPort,
  type MediaToolPluginDefinition,
} from "./mediaTools";

describe("public media tool port contract", () => {
  it("lets a plugin compose media tools strictly over capability-scoped host ports without server internals", async () => {
    const transcribe = vi.fn(async () => ({
      status: "transcribed" as const,
      text: "hello from host",
    }));
    const describeFolderImage = vi.fn(async () => ({
      status: "described" as const,
      imageName: "diagram.png",
      describedBy: { model: "Vision", provider: "Host" },
      description: "A clean diagram.",
    }));

    const plugin: MediaToolPluginDefinition = {
      kind: MEDIA_TOOL_CONTRIBUTION_KIND,
      id: "meeting-notes-helper",
      modes: ["work", "code"],
      createTools: (port) => {
        if (!port.transcription?.isAvailable() || !port.imageDescription?.isAvailable()) {
          return undefined;
        }
        return {
          definitions: [
            {
              name: "summarize_clip",
              description: "Transcribe a recording and inspect a slide through host media ports.",
              inputSchema: { type: "object", properties: { audio: { type: "string" } } },
            },
          ],
          taintPolicy: "outside-content",
          close: async () => undefined,
          execute: async ({ signal }) => {
            const speech = await port.transcription?.transcribe({
              relativePath: decodeCodeRelativePath("clip.m4a"),
              allowFreshRequest: true,
              ...(signal === undefined ? {} : { signal }),
            });
            const slide = await port.imageDescription?.describeFolderImage({
              relativePath: decodeCodeRelativePath("diagram.png"),
              mediaType: MEDIA_DESCRIBABLE_IMAGE_TYPES[0],
              ...(signal === undefined ? {} : { signal }),
            });
            return { result: { speech, slide } };
          },
        };
      },
    };

    const port: MediaToolHostPort = {
      turn: {
        mode: "work",
        hasFolder: true,
        unattended: false,
        inPlan: () => false,
        allowed: () => true,
      },
      transcription: { isAvailable: () => true, transcribe },
      imageDescription: {
        isAvailable: () => true,
        describeAttachment: async () => ({ status: "not-found" }),
        describeFolderImage,
      },
    };

    const tools = plugin.createTools(port);
    expect(tools?.definitions.map((d) => d.name)).toEqual(["summarize_clip"]);
    const outcome = await tools?.execute({ name: "summarize_clip", inputJson: "{}" });
    expect(outcome).toEqual({
      result: {
        speech: { status: "transcribed", text: "hello from host" },
        slide: {
          status: "described",
          imageName: "diagram.png",
          describedBy: { model: "Vision", provider: "Host" },
          description: "A clean diagram.",
        },
      },
    });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(describeFolderImage).toHaveBeenCalledOnce();
  });
});
