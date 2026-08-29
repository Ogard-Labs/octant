import { describe, expect, it, vi } from "vitest";
import type { ExternalContentIngestionResult } from "../context/externalContentIngestionStore";
import { taintAppManagedToolResults } from "./appManagedToolTaint";
import type { AppManagedToolSet } from "./appManagedToolSet";

const threadId = "20000000-0000-4000-8000-000000000001";
const correlationId = "30000000-0000-4000-8000-000000000001";

function tools(execute: AppManagedToolSet["execute"]): AppManagedToolSet {
  return {
    definitions: [{ name: "octant_terminal", inputSchema: { type: "object" } }],
    execute,
  };
}

describe("taintAppManagedToolResults", () => {
  it("journals taint for a successful native tool result and keeps the structured answer", async () => {
    const record = vi.fn(
      (): ExternalContentIngestionResult => ({
        kind: "recorded",
        taint: { externalContentIngested: true, ingestedSources: ["octant_terminal"] },
      }),
    );
    const wrapped = taintAppManagedToolResults({
      tools: tools(async () => ({
        result: { status: "running", transcript: "ok" },
        isError: false,
      })),
      threadId,
      recordExternalContentIngestion: record,
      uuid: () => correlationId,
    });

    const outcome = await wrapped.execute({ name: "octant_terminal", inputJson: "{}" });

    expect(outcome).toEqual({
      result: { status: "running", transcript: "ok" },
      isError: false,
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      threadId,
      provenance: { origin: "tool-result", sourceLabel: "octant_terminal" },
      contentReference: expect.stringMatching(/^app-managed-octant_terminal-[a-f0-9]{64}$/),
      correlationId,
      authorized: true,
    });
  });

  it("withholds a successful result when taint recording is refused", async () => {
    const record = vi.fn(
      (): ExternalContentIngestionResult => ({ kind: "refused", reason: "unauthorized" }),
    );
    const wrapped = taintAppManagedToolResults({
      tools: tools(async () => ({ result: { transcript: "secret" }, isError: false })),
      threadId,
      recordExternalContentIngestion: record,
      uuid: () => correlationId,
    });

    await expect(wrapped.execute({ name: "octant_terminal", inputJson: "{}" })).resolves.toEqual({
      result: { error: "tool-unavailable" },
      isError: true,
    });
  });

  it("does not taint host-side tool failures", async () => {
    const record = vi.fn();
    const wrapped = taintAppManagedToolResults({
      tools: tools(async () => ({ result: { error: "full-access-required" }, isError: true })),
      threadId,
      recordExternalContentIngestion: record,
      uuid: () => correlationId,
    });

    await expect(wrapped.execute({ name: "octant_terminal", inputJson: "{}" })).resolves.toEqual({
      result: { error: "full-access-required" },
      isError: true,
    });
    expect(record).not.toHaveBeenCalled();
  });
});
