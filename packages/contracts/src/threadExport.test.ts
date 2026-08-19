import { describe, expect, it } from "vitest";
import {
  THREAD_EXPORT_FORMAT,
  decodeThreadExportBundle,
  decodeThreadExportOutcome,
  decodeThreadExportRequest,
} from "./threadExport";

const threadId = "00000000-0000-4000-8000-000000000901";
const now = "2026-08-19T12:00:00.000Z";

const validBundle = {
  octant: {
    format: THREAD_EXPORT_FORMAT,
    threadId,
    mode: "chat",
    title: "Launch plan",
    hostId: "local",
    version: 4,
    sequence: 9,
    generatedAt: now,
  },
  transcript: {
    entries: [
      {
        role: "user",
        text: "What should we ship first?",
        occurredAt: now,
        status: "completed",
      },
    ],
    activeCount: 1,
    revisedCount: 0,
  },
  evidence: {
    artifacts: [],
    attachments: [],
    citations: [],
  },
  provenance: {
    mode: "chat",
    threadId,
    hostId: "local",
    providerInstanceId: "10000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    createdAt: now,
    updatedAt: now,
  },
  omissions: [],
} as const;

describe("thread export contracts", () => {
  it("decodes a request that names one thread", () => {
    expect(decodeThreadExportRequest({ mode: "chat", threadId })).toEqual({
      mode: "chat",
      threadId,
    });
  });

  it("refuses a request that names a path or an unknown mode", () => {
    expect(() => decodeThreadExportRequest({ mode: "chat", threadId: "/etc/passwd" })).toThrow();
    expect(() => decodeThreadExportRequest({ mode: "notes", threadId })).toThrow();
  });

  it("decodes a bundle that says when it was cut", () => {
    const bundle = decodeThreadExportBundle(validBundle);
    expect(bundle.octant.format).toBe(THREAD_EXPORT_FORMAT);
    expect(bundle.octant.generatedAt).toBe(now);
    expect(bundle.transcript.entries).toHaveLength(1);
  });

  it("refuses a bundle that invents a secret-bearing field", () => {
    expect(() =>
      decodeThreadExportBundle({
        ...validBundle,
        credentials: "sk-secret",
      }),
    ).toThrow();
  });

  it("decodes an exported outcome and a closed refusal", () => {
    expect(decodeThreadExportOutcome({ kind: "exported", bundle: validBundle }).kind).toBe(
      "exported",
    );
    expect(decodeThreadExportOutcome({ kind: "refused", reason: "not-found" })).toEqual({
      kind: "refused",
      reason: "not-found",
    });
    expect(() => decodeThreadExportOutcome({ kind: "refused", reason: "busy" })).toThrow();
  });
});
