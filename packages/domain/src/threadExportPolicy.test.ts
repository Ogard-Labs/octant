import { UtcTimestamp } from "@octant/contracts/events";
import { decodeHostId } from "@octant/contracts/host";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts/providers";
import { THREAD_EXPORT_FORMAT } from "@octant/contracts/thread-export";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  authorizeThreadExportActor,
  buildThreadExportBundle,
  collectOmissions,
  decideThreadExportAccess,
  serializeThreadExportBundle,
  threadExportContainsForbiddenKey,
  transcriptWithCounts,
  type ThreadExportActorKind,
  type ThreadExportSource,
} from "./threadExportPolicy";

const now = Schema.decodeUnknownSync(UtcTimestamp)("2026-08-19T12:00:00.000Z");
const threadId = "00000000-0000-4000-8000-000000000901";
const providerInstanceId = decodeProviderInstanceId("10000000-0000-4000-8000-000000000001");
const modelId = decodeProviderModelId("model-a");
const hostId = decodeHostId("local");
const projectId = decodeProjectId("20000000-0000-4000-8000-000000000001");

function source(overrides: Partial<ThreadExportSource> = {}): ThreadExportSource {
  return {
    threadId,
    mode: "chat",
    title: "Launch plan",
    hostId,
    projectId,
    version: 4,
    sequence: 9,
    generatedAt: now,
    providerInstanceId,
    modelId,
    createdAt: now,
    updatedAt: now,
    transcript: transcriptWithCounts(
      [
        {
          role: "user",
          text: "What should we ship first?",
          occurredAt: now,
          status: "completed",
        },
        {
          role: "assistant",
          text: "Start with the transcript.",
          occurredAt: now,
          status: "completed",
        },
      ],
      0,
    ),
    artifacts: [],
    attachments: [],
    citations: [],
    omissions: [],
    ...overrides,
  };
}

describe("authorizeThreadExportActor", () => {
  it("allows a local window and a paired device, because export is a read", () => {
    expect(authorizeThreadExportActor("local-window")).toEqual({ kind: "allowed" });
    expect(authorizeThreadExportActor("remote-device")).toEqual({ kind: "allowed" });
  });

  it.each<ThreadExportActorKind>(["provider", "automation", "extension"])(
    "fails closed for %s",
    (actorKind) => {
      expect(authorizeThreadExportActor(actorKind)).toEqual({
        kind: "denied",
        reason: "actor-not-reader",
      });
    },
  );
});

describe("decideThreadExportAccess", () => {
  it("allows a thread the caller can already read", () => {
    expect(decideThreadExportAccess({ exists: true, readable: true })).toEqual({ kind: "allow" });
  });

  it("refuses a missing thread and an unreadable thread the same way", () => {
    expect(decideThreadExportAccess({ exists: false, readable: false })).toEqual({
      kind: "refuse",
      reason: "not-found",
    });
    expect(decideThreadExportAccess({ exists: true, readable: false })).toEqual({
      kind: "refuse",
      reason: "not-found",
    });
  });
});

describe("buildThreadExportBundle", () => {
  it("cuts a portable bundle that names the thread, the evidence, and when it was taken", () => {
    const bundle = buildThreadExportBundle(
      source({
        artifacts: [
          {
            canvasId: "1a2b3c4d-0000-4000-8000-000000000001",
            versionId: "30000000-0000-4000-8000-000000000001",
            sequence: 2,
            title: "Launch diagram",
            updatedAt: now,
            definition: {
              title: "Launch diagram",
              blocks: [{ kind: "diagram" }],
            },
          },
        ],
        attachments: [
          {
            displayName: "brief.pdf",
            mediaType: "application/pdf",
            byteLength: 1200,
            status: "finalized",
          },
        ],
        omissions: collectOmissions({ "attachment-bytes": 1 }),
      }),
    );

    expect(bundle.octant).toMatchObject({
      format: THREAD_EXPORT_FORMAT,
      threadId,
      mode: "chat",
      title: "Launch plan",
      version: 4,
      sequence: 9,
      generatedAt: now,
    });
    expect(bundle.transcript.entries).toHaveLength(2);
    expect(bundle.evidence.artifacts[0]?.kind).toBe("diagram");
    expect(bundle.evidence.attachments[0]?.displayName).toBe("brief.pdf");
    expect(bundle.omissions).toEqual([{ kind: "attachment-bytes", count: 1 }]);
  });

  it("writes stable JSON so one later change shows one changed line", () => {
    const before = serializeThreadExportBundle(buildThreadExportBundle(source()));
    const after = serializeThreadExportBundle(
      buildThreadExportBundle(
        source({
          transcript: transcriptWithCounts(
            [
              {
                role: "user",
                text: "What should we ship second?",
                occurredAt: now,
                status: "completed",
              },
              {
                role: "assistant",
                text: "Start with the transcript.",
                occurredAt: now,
                status: "completed",
              },
            ],
            0,
          ),
        }),
      ),
    );
    expect(before.endsWith("\n")).toBe(true);
    const changed = after.split("\n").filter((line, index) => line !== before.split("\n")[index]);
    expect(changed).toHaveLength(1);
  });

  it("never carries secret-bearing keys", () => {
    const serialized = serializeThreadExportBundle(buildThreadExportBundle(source()));
    expect(threadExportContainsForbiddenKey(JSON.parse(serialized))).toBe(false);
    expect(serialized).not.toContain("credentials");
    expect(serialized).not.toContain("resumeCursor");
  });
});
