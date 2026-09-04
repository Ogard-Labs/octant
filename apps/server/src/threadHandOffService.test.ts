import { THREAD_EXPORT_FORMAT, type ThreadExportBundle } from "@octant/contracts/thread-export";
import { describe, expect, it, vi } from "vitest";
import { ThreadHandOffService } from "./threadHandOffService";

const now = "2026-08-19T12:00:00.000Z";
const windowId = "70000000-0000-4000-8000-000000000001" as never;
const threadId = "00000000-0000-4000-8000-000000000901";
const projectId = "20000000-0000-4000-8000-000000000001";
const providerInstanceId = "10000000-0000-4000-8000-000000000001";

function bundle(overrides: Partial<ThreadExportBundle> = {}): ThreadExportBundle {
  return {
    octant: {
      format: THREAD_EXPORT_FORMAT,
      threadId,
      mode: "code",
      title: "Controller foundation",
      projectId: projectId as never,
      hostId: "local" as never,
      version: 4,
      sequence: 9,
      generatedAt: now as never,
    },
    transcript: {
      entries: [
        {
          role: "user",
          text: "Wire the controller.",
          occurredAt: now as never,
          status: "completed",
        },
        {
          role: "assistant",
          text: "Done; tests pass.",
          occurredAt: now as never,
          status: "completed",
        },
      ],
      activeCount: 2,
      revisedCount: 0,
    },
    evidence: { artifacts: [], attachments: [], citations: [] },
    provenance: {
      mode: "code",
      threadId,
      hostId: "local" as never,
      providerInstanceId: providerInstanceId as never,
      modelId: "model-a" as never,
      createdAt: now as never,
      updatedAt: now as never,
    },
    omissions: [],
    ...overrides,
  };
}

function setup(input: {
  readonly exported?: ThreadExportBundle;
  readonly readiness?: "ready" | "unavailable" | undefined;
  readonly markdown?: string;
  readonly saveRefusal?: string;
}) {
  const exportThread = vi.fn(async () =>
    input.exported === undefined
      ? ({ kind: "refused", reason: "not-found" } as const)
      : ({ kind: "exported", bundle: input.exported } as const),
  );
  const complete = vi.fn(
    async () => input.markdown ?? "## Objective\nShip it.\n\n## How to continue\n- Run the tests.",
  );
  const save = vi.fn(async () =>
    input.saveRefusal === undefined
      ? ({
          kind: "saved" as const,
          canvasId: "30000000-0000-4000-8000-000000000001",
          versionId: "30000000-0000-4000-8000-000000000002",
        } as const)
      : ({ kind: "refused" as const, message: input.saveRefusal } as const),
  );
  const service = new ThreadHandOffService({
    exports: { exportThread: exportThread as never },
    provider: { readiness: () => ("readiness" in input ? input.readiness : "ready"), complete },
    documents: { save },
  });
  return { service, exportThread, complete, save };
}

describe("handing off a thread", () => {
  it("writes the document with the thread's provider and keeps it as a Canvas of the thread", async () => {
    const { service, complete, save } = setup({ exported: bundle() });
    const outcome = await service.handOff(windowId, "local-window", { mode: "code", threadId });
    expect(outcome).toEqual({
      kind: "handed-off",
      canvasId: "30000000-0000-4000-8000-000000000001",
      versionId: "30000000-0000-4000-8000-000000000002",
      projectId,
      title: "Hand-off: Controller foundation",
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        providerInstanceId,
        modelId: "model-a",
        mode: "code",
        threadId,
        prompt: expect.stringContaining("Wire the controller."),
      }),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId,
        mode: "code",
        threadId,
        projectId,
        title: "Hand-off: Controller foundation",
        blocks: [
          expect.objectContaining({ kind: "heading", text: "Objective" }),
          expect.objectContaining({ kind: "rich-text", text: "Ship it." }),
          expect.objectContaining({ kind: "heading", text: "How to continue" }),
          expect.objectContaining({ kind: "rich-text", text: "• Run the tests." }),
        ],
      }),
    );
  });

  it("refuses while a turn is running and never asks the provider", async () => {
    const { service, complete } = setup({
      exported: bundle({ omissions: [{ kind: "in-progress", count: 1 }] }),
    });
    expect(await service.handOff(windowId, "local-window", { mode: "code", threadId })).toEqual({
      kind: "refused",
      reason: "turn-running",
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses when the thread's provider is not ready on this host", async () => {
    const unavailable = setup({ exported: bundle(), readiness: "unavailable" });
    expect(
      await unavailable.service.handOff(windowId, "local-window", { mode: "code", threadId }),
    ).toEqual({
      kind: "refused",
      reason: "provider-unavailable",
      message: "This thread's provider is unavailable.",
    });
    const unknown = setup({ exported: bundle(), readiness: undefined });
    expect(
      await unknown.service.handOff(windowId, "local-window", { mode: "code", threadId }),
    ).toMatchObject({ kind: "refused", reason: "provider-unavailable" });
    expect(unavailable.complete).not.toHaveBeenCalled();
  });

  it("refuses a thread the caller may not export, the same way export does", async () => {
    const { service } = setup({});
    expect(await service.handOff(windowId, "local-window", { mode: "chat", threadId })).toEqual({
      kind: "refused",
      reason: "not-found",
    });
    expect(await service.handOff(windowId, "local-window", { mode: "chat" })).toEqual({
      kind: "refused",
      reason: "not-found",
    });
  });

  it("still refuses readably when the document port denies at length", async () => {
    // The contract bounds a refusal message at 400 characters and the port's
    // own denial text is unbounded, so an over-long denial must stay a
    // refusal rather than fail to decode into one.
    const { service } = setup({ exported: bundle(), saveRefusal: "n".repeat(900) });
    const outcome = await service.handOff(windowId, "local-window", { mode: "code", threadId });
    expect(outcome).toMatchObject({ kind: "refused", reason: "document-refused" });
    expect(outcome.kind === "refused" ? outcome.message : "").toHaveLength(400);
  });

  it("says so when the provider answers with nothing usable", async () => {
    const { service, save } = setup({ exported: bundle(), markdown: "\n\n" });
    expect(await service.handOff(windowId, "local-window", { mode: "code", threadId })).toEqual({
      kind: "refused",
      reason: "document-not-produced",
      message: "The provider answered with an empty document.",
    });
    expect(save).not.toHaveBeenCalled();
  });
});
