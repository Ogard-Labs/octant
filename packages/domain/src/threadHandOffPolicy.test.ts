import { decodeCanvasBlock } from "@octant/contracts/canvas";
import { THREAD_EXPORT_FORMAT, type ThreadExportBundle } from "@octant/contracts/thread-export";
import { describe, expect, it } from "vitest";
import {
  buildThreadHandOffPrompt,
  decideThreadHandOff,
  threadHandOffDocumentBlocks,
  threadHandOffTitle,
} from "./threadHandOffPolicy";

const now = "2026-08-19T12:00:00.000Z";

function bundle(overrides: Partial<ThreadExportBundle> = {}): ThreadExportBundle {
  return {
    octant: {
      format: THREAD_EXPORT_FORMAT,
      threadId: "00000000-0000-4000-8000-000000000901",
      mode: "chat",
      title: "Launch plan",
      projectId: "20000000-0000-4000-8000-000000000001" as never,
      hostId: "local" as never,
      version: 4,
      sequence: 9,
      generatedAt: now as never,
    },
    transcript: {
      entries: [
        {
          role: "user",
          text: "Ship the transcript first.",
          occurredAt: now as never,
          status: "completed",
        },
        {
          role: "assistant",
          text: "Agreed; evidence next.",
          occurredAt: now as never,
          status: "completed",
        },
      ],
      activeCount: 2,
      revisedCount: 0,
    },
    evidence: { artifacts: [], attachments: [], citations: [] },
    provenance: {
      mode: "chat",
      threadId: "00000000-0000-4000-8000-000000000901",
      hostId: "local" as never,
      providerInstanceId: "10000000-0000-4000-8000-000000000001" as never,
      modelId: "model-a" as never,
      createdAt: now as never,
      updatedAt: now as never,
    },
    omissions: [],
    ...overrides,
  };
}

describe("handing off a thread", () => {
  it("refuses while a turn is still running, outside a Project, or with nothing to hand off", () => {
    expect(decideThreadHandOff(bundle())).toEqual({ kind: "allow" });
    expect(decideThreadHandOff(bundle({ omissions: [{ kind: "in-progress", count: 1 }] }))).toEqual(
      {
        kind: "refuse",
        reason: "turn-running",
      },
    );
    const unfiled = bundle();
    const { projectId: _projectId, ...header } = unfiled.octant;
    expect(decideThreadHandOff({ ...unfiled, octant: header })).toEqual({
      kind: "refuse",
      reason: "project-required",
    });
    expect(
      decideThreadHandOff(bundle({ transcript: { entries: [], activeCount: 0, revisedCount: 0 } })),
    ).toEqual({ kind: "refuse", reason: "empty-thread" });
  });

  it("asks the provider for the six hand-off sections over the export cut", () => {
    const prompt = buildThreadHandOffPrompt(bundle());
    expect(prompt).toContain("## Objective");
    expect(prompt).toContain("## How to continue");
    expect(prompt).toContain("Ship the transcript first.");
    expect(prompt).toContain("Thread: Launch plan (chat mode)");
    expect(threadHandOffTitle(bundle())).toBe("Hand-off: Launch plan");
  });

  it("keeps the most recent turns when the transcript is longer than the prompt allows", () => {
    const long = "x".repeat(20_000);
    const entries = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `${String(index)} ${long}`,
      occurredAt: now as never,
      status: "completed" as const,
    }));
    const prompt = buildThreadHandOffPrompt(
      bundle({ transcript: { entries, activeCount: 6, revisedCount: 0 } }),
    );
    expect(prompt).toContain("earlier entries omitted for length");
    expect(prompt).toContain("\n5 ");
    expect(prompt).not.toContain("\n0 ");
  });

  it("turns the provider's Markdown into headings and paragraphs the Canvas catalog accepts", () => {
    const blocks = threadHandOffDocumentBlocks(
      [
        "## Objective",
        "Ship **the transcript** first.",
        "",
        "## What is left",
        "- Evidence `bundle`",
        "- Provenance",
        "",
        "```",
        "ignored fence",
        "```",
        "Then continue.",
      ].join("\n"),
    );
    expect(blocks.map((block) => decodeCanvasBlock(block).kind)).toEqual([
      "heading",
      "rich-text",
      "heading",
      "rich-text",
      "rich-text",
      "rich-text",
    ]);
    expect(blocks[1]).toMatchObject({ text: "Ship the transcript first." });
    expect(blocks[3]).toMatchObject({ text: "• Evidence bundle\n• Provenance" });
    // A fence the provider was told not to write keeps its text and loses its markers.
    expect(blocks[4]).toMatchObject({ text: "ignored fence" });
    expect(threadHandOffDocumentBlocks("\n\n")).toEqual([]);
  });
});
