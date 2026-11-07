import { createProductFeedbackClient } from "@octant/client-runtime/product-feedback-client";
import {
  decodeProductFeedbackCommand,
  decodeProductFeedbackNote,
  type ProductFeedbackCommand,
} from "@octant/contracts/product-feedback";
import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProductFeedback } from "./useProductFeedback";

const threadId = "20000000-0000-4000-8000-000000000001";
const contextId = "20000000-0000-4000-8000-000000000002";
const previewId = "20000000-0000-4000-8000-000000000003";
const noteId = "20000000-0000-4000-8000-000000000004";
const crop = "data:image/jpeg;base64,/9j/AA==";
function note() {
  return decodeProductFeedbackNote({
    id: noteId,
    threadId,
    mode: "code",
    comment: "Original comment",
    element: {
      kind: "browser-element",
      selector: "#save",
      bounds: { x: 0.1, y: 0.2, width: 0.1, height: 0.1 },
    },
    provenance: {
      comment: { origin: "user", sourceLabel: "product-feedback-comment" },
      element: { origin: "external-content", sourceLabel: "browser-page" },
    },
    lifecycle: "pending",
    version: 1,
    capturedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
function preview() {
  const source = note();
  return {
    id: previewId,
    threadId,
    mode: "code",
    element: source.element,
    provenance: source.provenance,
    cropDataUrl: crop,
    capturedAt: source.capturedAt,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}
function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
function host(options: { timeout?: number; prepare?: () => Promise<Response> } = {}) {
  let notes = [note()];
  const commands: ProductFeedbackCommand[] = [];
  const transport = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get("x-octant-window-capability")).toBe("local-capability");
    if (init?.method !== "POST") return response({ notes });
    const command = decodeProductFeedbackCommand(JSON.parse(String(init.body)));
    commands.push(command);
    if (command.kind === "prepare-product-feedback")
      return options.prepare?.() ?? response({ kind: "feedback-prepared", preview: preview() });
    if (command.kind === "cancel-product-feedback-preview")
      return response({ kind: "feedback-preview-cancelled", previewId: command.previewId });
    if (command.kind === "commit-product-feedback") {
      notes = [decodeProductFeedbackNote({ ...note(), comment: command.comment })];
      return response({ kind: "feedback-captured", note: notes[0] });
    }
    if (command.kind === "update-product-feedback" || command.kind === "discard-product-feedback") {
      const previous = notes[0];
      if (previous === undefined) throw Error("Fixture note missing");
      expect(command.expectedVersion).toBe(previous.version);
      const changed = decodeProductFeedbackNote({
        ...previous,
        version: previous.version + 1,
        ...(command.kind === "update-product-feedback"
          ? {
              ...(command.comment === undefined ? {} : { comment: command.comment }),
              ...(command.included === undefined ? {} : { included: command.included }),
            }
          : { lifecycle: "discarded" }),
      });
      notes = changed.lifecycle === "pending" ? [changed] : [];
      return response({
        kind:
          command.kind === "update-product-feedback" ? "feedback-updated" : "feedback-discarded",
        note: changed,
      });
    }
    throw Error("Unexpected fixture command");
  });
  return {
    commands,
    transport,
    client: createProductFeedbackClient({
      baseUrl: "http://127.0.0.1:4319",
      fetch: transport,
      windowCapability: "local-capability",
      requestTimeoutMs: options.timeout ?? 1_000,
    }),
  };
}
const point = { contextId, expectedObservationRevision: 7, point: { x: 0.2, y: 0.3 } };

describe("feedback surface through the actual typed host client", () => {
  it("keeps notes and capture commands available after development effect replay", async () => {
    const fixture = host();
    const { result } = renderHook(
      () => useProductFeedback({ threadId, mode: "code", client: fixture.client }),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    let prepared = false;
    await act(async () => {
      prepared = await result.current.prepare(point);
    });
    expect(prepared).toBe(true);
    expect(result.current.preview?.id).toBe(previewId);
    await act(async () => {
      await result.current.commit("After effect replay");
    });
    expect(result.current.pending[0]?.comment).toBe("After effect replay");
  });

  it("previews before commit, then amends, chooses and removes the exact pending version without sending", async () => {
    const h = host();
    const view = renderHook(() => useProductFeedback({ threadId, mode: "code", client: h.client }));
    await waitFor(() => expect(view.result.current.pending).toHaveLength(1));
    await act(async () => {
      expect(await view.result.current.prepare(point)).toBe(true);
    });
    expect(view.result.current.preview?.cropDataUrl).toBe(crop);
    expect(h.commands).toEqual([{ kind: "prepare-product-feedback", threadId, ...point }]);
    await act(async () => {
      expect(await view.result.current.commit("Person comment")).toBe(true);
    });
    expect(view.result.current.preview).toBeUndefined();
    expect(view.result.current.pending[0]?.comment).toBe("Person comment");
    await act(async () => {
      expect(
        await view.result.current.update(view.result.current.pending[0]!, { included: false }),
      ).toBe(true);
    });
    await act(async () => {
      expect(
        await view.result.current.update(view.result.current.pending[0]!, {
          comment: "Amended comment",
          included: true,
        }),
      ).toBe(true);
    });
    expect(view.result.current.pending[0]).toMatchObject({
      comment: "Amended comment",
      included: true,
      version: 3,
    });
    await act(async () => {
      await view.result.current.discard(view.result.current.pending[0]!);
    });
    expect(view.result.current.pending).toEqual([]);
    expect(h.commands.map((command) => command.kind)).toEqual([
      "prepare-product-feedback",
      "commit-product-feedback",
      "update-product-feedback",
      "update-product-feedback",
      "discard-product-feedback",
    ]);
    view.unmount();
  });

  it("does not adopt a retired client's late preview even for the same task", async () => {
    const held = Promise.withResolvers<Response>();
    const old = host({ prepare: () => held.promise }),
      replacement = host();
    const view = renderHook(
      ({ client }) => useProductFeedback({ threadId, mode: "code", client }),
      { initialProps: { client: old.client } },
    );
    await waitFor(() => expect(view.result.current.pending).toHaveLength(1));
    let pending = Promise.resolve(false);
    act(() => {
      pending = view.result.current.prepare(point);
    });
    await waitFor(() => expect(view.result.current.busy).toBe(true));
    const signal = old.transport.mock.calls.at(-1)?.[1]?.signal;
    view.rerender({ client: replacement.client });
    await act(async () => {
      expect(await pending).toBe(false);
    });
    expect(signal?.aborted).toBe(true);
    held.resolve(response({ kind: "feedback-prepared", preview: preview() }));
    await waitFor(() => expect(view.result.current.pending).toHaveLength(1));
    expect(view.result.current.preview).toBeUndefined();
    view.unmount();
  });

  it("rejects a validly decoded preview from another mode and keeps commit unavailable", async () => {
    const h = host({
      prepare: async () =>
        response({ kind: "feedback-prepared", preview: { ...preview(), mode: "work" } }),
    });
    const view = renderHook(() => useProductFeedback({ threadId, mode: "code", client: h.client }));
    await waitFor(() => expect(view.result.current.pending).toHaveLength(1));
    await act(async () => {
      expect(await view.result.current.prepare(point)).toBe(false);
    });
    expect(view.result.current.message).toContain("different task");
    expect(view.result.current.preview).toBeUndefined();
    await act(async () => {
      expect(await view.result.current.commit("Keep my comment")).toBe(false);
    });
    expect(h.commands).toHaveLength(1);
    view.unmount();
  });

  it("restores retry after a finite prepare timeout and ignores late host evidence", async () => {
    const held = Promise.withResolvers<Response>();
    let attempts = 0;
    const h = host({
      timeout: 20,
      prepare: () =>
        ++attempts === 1
          ? held.promise
          : Promise.resolve(response({ kind: "feedback-prepared", preview: preview() })),
    });
    const view = renderHook(() => useProductFeedback({ threadId, mode: "code", client: h.client }));
    await waitFor(() => expect(view.result.current.pending).toHaveLength(1));
    await act(async () => {
      expect(await view.result.current.prepare(point)).toBe(false);
    });
    expect(view.result.current.busy).toBe(false);
    expect(view.result.current.message).toContain("Refresh notes");
    held.resolve(response({ kind: "feedback-prepared", preview: preview() }));
    expect(view.result.current.preview).toBeUndefined();
    await act(async () => {
      expect(await view.result.current.prepare(point)).toBe(true);
    });
    expect(view.result.current.preview?.id).toBe(previewId);
    view.unmount();
  });
});
