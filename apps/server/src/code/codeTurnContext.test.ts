import { describe, expect, it } from "vitest";
import { decodeCodeThread } from "@octant/contracts";
import {
  carriedSentContext,
  composeCodeProfileContext,
  estimateImageTokens,
  estimateOctantToolsPart,
  estimateSentContextParts,
  octantWindowBreakdown,
  type CodeTurnContextAccount,
} from "./codeTurnContext";

const now = "2026-07-21T10:00:00.000Z";
const thread = decodeCodeThread({
  id: "22222222-2222-4222-8222-222222222222",
  projectId: "66666666-6666-4666-8666-666666666666",
  bindingRevisionId: "77777777-7777-4777-8777-777777777777",
  repositoryId: `repo_${"8".repeat(64)}`,
  checkoutId: "33333333-3333-4333-8333-333333333333",
  title: "Exact checkout",
  lifecycle: "active",
  providerInstanceId: "99999999-9999-4999-8999-999999999999",
  modelId: "model-id",
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "feature/exact",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "development",
    outcomeKind: "opened-pr",
    confirmedAt: now,
  },
  version: 1,
  createdAt: now,
  updatedAt: now,
});

describe("composeCodeProfileContext", () => {
  it("includes snapshotted profile instructions with attribution", () => {
    let n = 0;
    const composed = composeCodeProfileContext({
      thread: decodeCodeThread({
        ...thread,
        profileId: "60000000-0000-4000-8000-000000000001",
        profileContext: {
          displayName: "Reviewer",
          instructions: "Review as a skeptic.",
          approvedSkillIds: [],
        },
      }),
      uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`,
    });

    expect(composed.entries).toEqual([
      expect.objectContaining({
        category: "user-instructions",
        label: "Reviewer profile instructions",
        source: {
          kind: "instruction",
          referenceId: "profile:60000000-0000-4000-8000-000000000001",
        },
      }),
    ]);
    expect(composed.blocks).toEqual([{ kind: "instructions", text: "Review as a skeptic." }]);
  });

  it("leaves a thread without a profile unchanged", () => {
    const composed = composeCodeProfileContext({
      thread,
      skills: [
        {
          qualifiedId: "agents-skills-directory:project:code-reviewer:sha256:aa",
          displayName: "Code reviewer",
          text: "should never load",
        },
      ],
      uuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    });
    expect(composed).toEqual({
      entries: [],
      blocks: [],
      sent: { instructions: [], skills: [] },
    });
  });

  it("attributes admitted skills as extension instructions", () => {
    let n = 0;
    const composed = composeCodeProfileContext({
      thread: decodeCodeThread({
        ...thread,
        profileId: "60000000-0000-4000-8000-000000000001",
        profileContext: {
          displayName: "Reviewer",
          approvedSkillIds: ["code-reviewer"],
        },
      }),
      skills: [
        {
          qualifiedId: "agents-skills-directory:project:code-reviewer:sha256:aa",
          displayName: "Code reviewer",
          text: "Review diffs in isolation.",
        },
      ],
      uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`,
    });

    expect(composed.entries).toEqual([
      expect.objectContaining({
        category: "extension-instructions",
        label: "Code reviewer",
        source: {
          kind: "skill",
          referenceId: "agents-skills-directory:project:code-reviewer:sha256:aa",
        },
      }),
    ]);
    expect(composed.blocks).toEqual([{ kind: "instructions", text: "Review diffs in isolation." }]);
    // The window accounting names a skill apart from a profile's instructions.
    expect(composed.sent).toEqual({ instructions: [], skills: composed.blocks });
  });
});

describe("estimateOctantToolsPart", () => {
  const tool = (name: string, description?: string) => ({
    name,
    ...(description === undefined ? {} : { description }),
    inputSchema: { type: "object" },
  });

  it("counts the registered definitions as a conservative estimate, never as the provider's figure", () => {
    const definitions = [tool("octant_a", "Read a file."), tool("octant_b")];

    const part = estimateOctantToolsPart(definitions)?.parts[0];

    expect(part).toEqual({
      kind: "octant-tools",
      tokens: definitions.reduce(
        (sum, definition) => sum + Math.max(16, Math.ceil(JSON.stringify(definition).length / 4)),
        0,
      ),
      accuracy: "conservative-heuristic",
      count: 2,
    });
  });

  it("counts a long definition by its size and a tiny one at the floor", () => {
    const long = estimateOctantToolsPart([tool("octant_long", "x".repeat(4_000))])?.parts[0];
    const tiny = estimateOctantToolsPart([tool("t")])?.parts[0];

    expect(long?.tokens).toBeGreaterThan(1_000);
    expect(tiny?.tokens).toBe(16);
  });

  it("names nothing when Octant registered no tools", () => {
    expect(estimateOctantToolsPart([])).toBeUndefined();
  });
});

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment to skip, then a baseline start-of-frame.
  const bytes = new Uint8Array(2 + 18 + 19);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 16], 0);
  const frame = 2 + 18;
  bytes.set([0xff, 0xc0, 0, 17, 8], frame);
  const view = new DataView(bytes.buffer);
  view.setUint16(frame + 5, height);
  view.setUint16(frame + 7, width);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const w = width - 1;
  const h = height - 1;
  bytes.set(
    [w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff],
    24,
  );
  return bytes;
}

describe("estimateImageTokens", () => {
  it.each([
    ["PNG", png],
    ["GIF", gif],
    ["JPEG", jpeg],
    ["WebP", webp],
  ])("reads a %s picture's size and charges it by area", (_name, image) => {
    expect(estimateImageTokens(image(300, 200))).toBe(80);
  });

  it("scales a large picture down as a provider would, and never past the cap", () => {
    expect(estimateImageTokens(png(4_000, 3_000))).toBeLessThanOrEqual(1_600);
    expect(estimateImageTokens(png(4_000, 3_000))).toBeGreaterThan(1_400);
  });

  it("takes the cap for a picture whose size it cannot read", () => {
    expect(estimateImageTokens(new Uint8Array([1, 2, 3]))).toBe(1_600);
  });
});

describe("what Octant sends with a turn", () => {
  const instructions = { kind: "instructions", text: "Review as a skeptic." } as const;
  const skill = { kind: "instructions", text: "x".repeat(400) } as const;

  it("counts instructions, skills and pictures apart, as JSON at four characters to a token", () => {
    expect(
      estimateSentContextParts({
        sent: { instructions: [instructions], skills: [skill] },
        attachments: [
          {
            attachmentId: "a",
            displayName: "shot.png",
            mediaType: "image/png",
            bytes: png(300, 200),
          },
        ],
      }),
    ).toEqual([
      { kind: "octant-instructions", tokens: 16, accuracy: "conservative-heuristic" },
      {
        kind: "skills",
        tokens: Math.ceil(JSON.stringify(skill).length / 4),
        accuracy: "conservative-heuristic",
      },
      { kind: "attachments", tokens: 80, accuracy: "conservative-heuristic" },
    ]);
  });

  it("names nothing a turn did not send", () => {
    expect(estimateSentContextParts({})).toEqual([]);
  });
});

describe("what the session already held", () => {
  const counted = {
    parts: [
      { kind: "octant-tools", tokens: 50, accuracy: "conservative-heuristic", count: 1 },
      { kind: "skills", tokens: 300, accuracy: "conservative-heuristic" },
    ],
    sentContext: { status: "counted" },
  } as const;

  it("starts a new provider session empty", () => {
    expect(carriedSentContext({ freshSession: true, forkSeeded: false, priorTurn: true })).toEqual({
      status: "counted",
      parts: [],
    });
  });

  it("carries the copies the prior turn counted, without its tool definitions", () => {
    expect(
      carriedSentContext({
        freshSession: false,
        forkSeeded: false,
        priorTurn: true,
        previousBreakdown: counted,
      }),
    ).toEqual({ status: "counted", parts: [counted.parts[1]] });
  });

  it("stays uncounted once a turn of the session was", () => {
    expect(
      carriedSentContext({
        freshSession: false,
        forkSeeded: false,
        priorTurn: true,
        previousBreakdown: { parts: [], sentContext: { status: "uncounted", reason: "compacted" } },
      }),
    ).toEqual({ status: "uncounted", reason: "compacted" });
  });

  it("refuses to guess after a prior turn that left no count", () => {
    expect(carriedSentContext({ freshSession: false, forkSeeded: false, priorTurn: true })).toEqual(
      { status: "uncounted", reason: "history-unknown" },
    );
    expect(
      carriedSentContext({
        freshSession: false,
        forkSeeded: false,
        priorTurn: true,
        previousBreakdown: { parts: [] },
      }),
    ).toEqual({ status: "uncounted", reason: "history-unknown" });
  });

  it("refuses to guess for a fork that starts from another thread's conversation", () => {
    expect(carriedSentContext({ freshSession: false, forkSeeded: true, priorTurn: false })).toEqual(
      { status: "uncounted", reason: "history-unknown" },
    );
  });
});

describe("octantWindowBreakdown", () => {
  const part = (kind: "octant-instructions" | "skills" | "attachments", tokens: number) =>
    ({ kind, tokens, accuracy: "conservative-heuristic" }) as const;
  const account: CodeTurnContextAccount = {
    carried: { status: "counted", parts: [part("octant-instructions", 100), part("skills", 300)] },
    turn: [part("octant-instructions", 100), part("skills", 300), part("attachments", 80)],
  };

  // Codex, OpenCode and Pi keep each turn's prompt until they compact.
  it("holds one copy per turn while the runtime keeps its prompts", () => {
    expect(octantWindowBreakdown({ tools: [], account, promptRetention: "kept" })).toEqual({
      parts: [part("octant-instructions", 200), part("skills", 600), part("attachments", 80)],
      sentContext: { status: "counted" },
    });
  });

  it("stops counting when the runtime compacted, because what it kept is its own choice", () => {
    expect(octantWindowBreakdown({ tools: [], account, promptRetention: "compacted" })).toEqual({
      parts: [],
      sentContext: { status: "uncounted", reason: "compacted" },
    });
  });

  // An ACP agent manages its own history and says nothing of it.
  it("does not count for a runtime that does not say what it keeps", () => {
    expect(octantWindowBreakdown({ tools: [], account })).toEqual({
      parts: [],
      sentContext: { status: "uncounted", reason: "retention-unknown" },
    });
  });

  it("still counts tool definitions, once, whatever happened to the prompts", () => {
    const tools = [{ name: "octant_a", inputSchema: { type: "object" } }];
    expect(octantWindowBreakdown({ tools, account, promptRetention: "compacted" })?.parts).toEqual(
      estimateOctantToolsPart(tools)?.parts,
    );
  });

  it("counts a session that sent nothing as counted, so a later turn can start from it", () => {
    expect(
      octantWindowBreakdown({
        tools: [],
        account: { carried: { status: "counted", parts: [] }, turn: [] },
      }),
    ).toEqual({ parts: [], sentContext: { status: "counted" } });
  });
});
