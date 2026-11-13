import { describe, expect, it } from "vitest";
import { decodeProviderRuntimeEvent } from "./providers";
import { decodeThreadExportBundle, THREAD_EXPORT_FORMAT } from "./threadExport";
import {
  decodeThreadToolCallRecord,
  decodeThreadToolCallRecordsRequest,
  MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS,
  MAX_TOOL_CALL_RECORD_INPUT_BYTES,
  MAX_TOOL_CALL_RECORD_OUTPUT_BYTES,
} from "./threadToolCallRecords";

const now = "2026-11-12T12:00:00.000Z";
const threadId = "7e000000-0000-4000-8000-000000000001";

describe("tool-call records", () => {
  it("refuses a record whose input or output is past its byte bound", () => {
    const record = { toolCallId: "call-1", toolName: "Bash", recordedAt: now };
    expect(
      decodeThreadToolCallRecord({
        ...record,
        input: { text: "x".repeat(MAX_TOOL_CALL_RECORD_INPUT_BYTES), truncated: true },
        output: { text: "y".repeat(MAX_TOOL_CALL_RECORD_OUTPUT_BYTES), truncated: false },
      }).input?.truncated,
    ).toBe(true);
    expect(() =>
      decodeThreadToolCallRecord({
        ...record,
        input: { text: "x".repeat(MAX_TOOL_CALL_RECORD_INPUT_BYTES + 1), truncated: true },
      }),
    ).toThrow();
    expect(() =>
      decodeThreadToolCallRecord({
        ...record,
        output: { text: "é".repeat(MAX_TOOL_CALL_RECORD_OUTPUT_BYTES / 2 + 1), truncated: true },
      }),
    ).toThrow();
  });

  it("asks for a Chat or Work turn's records and for no other mode's", () => {
    const request = { mode: "work", threadId, turnId: "7e000000-0000-4000-8000-0000000000a1" };
    expect(decodeThreadToolCallRecordsRequest(request)).toEqual(request);
    expect(() => decodeThreadToolCallRecordsRequest({ ...request, mode: "code" })).toThrow();
    expect(() => decodeThreadToolCallRecordsRequest({ ...request, threadId: "../x" })).toThrow();
  });

  it("carries a call's input or output on a runtime event bounded in length", () => {
    const event = {
      instanceId: "7e000000-0000-4000-8000-0000000000b1",
      sessionId: "7e000000-0000-4000-8000-0000000000b2",
      sequence: 1,
      correlationId: "7e000000-0000-4000-8000-0000000000b3",
      occurredAt: now,
      kind: "tool-call-content",
      toolCallId: "call-1",
      part: "output",
      text: "x".repeat(MAX_TOOL_CALL_CONTENT_EVENT_CHARACTERS),
      truncated: true,
    };
    expect(decodeProviderRuntimeEvent(event).kind).toBe("tool-call-content");
    expect(() => decodeProviderRuntimeEvent({ ...event, text: `${event.text}x` })).toThrow();
    expect(() => decodeProviderRuntimeEvent({ ...event, part: "summary" })).toThrow();
  });

  it("decodes a thread export cut before records existed and one that carries them", () => {
    const bundle = {
      octant: {
        format: THREAD_EXPORT_FORMAT,
        threadId,
        mode: "work",
        title: "Launch plan",
        hostId: "local",
        version: 1,
        sequence: 1,
        generatedAt: now,
      },
      transcript: { entries: [], activeCount: 0, revisedCount: 0 },
      evidence: { artifacts: [], attachments: [], citations: [] },
      provenance: {
        mode: "work",
        threadId,
        hostId: "local",
        providerInstanceId: "7e000000-0000-4000-8000-0000000000b1",
        modelId: "model-a",
        createdAt: now,
        updatedAt: now,
      },
      omissions: [],
    };
    expect(decodeThreadExportBundle(bundle).evidence.toolCalls).toBeUndefined();
    const toolCall = {
      turnId: "7e000000-0000-4000-8000-0000000000a1",
      toolCallId: "call-1",
      toolName: "Bash",
      input: { text: "ls", truncated: false },
      outputWithheld: "protected-path",
      recordedAt: now,
    };
    expect(
      decodeThreadExportBundle({
        ...bundle,
        evidence: { ...bundle.evidence, toolCalls: [toolCall] },
      }).evidence.toolCalls,
    ).toEqual([toolCall]);
  });
});
