import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { PreviewClient } from "@octant/client-runtime/preview-client";
import { PreviewClientFailure } from "@octant/client-runtime/preview-client";
import {
  decodePreviewHostId,
  decodePreviewTargetId,
  decodePreviewSourceVersion,
  type PreviewChunksReply,
  type PreviewOutcome,
  type PreviewTarget,
} from "@octant/contracts/previews";
import { decodeProjectId } from "@octant/contracts/projects";
import { usePreviewController } from "./usePreviewController";

const targetId = decodePreviewTargetId("11111111-1111-4111-8111-111111111111");
const projectId = decodeProjectId("22222222-2222-4222-8222-222222222222");
const hostId = decodePreviewHostId("33333333-3333-4333-8333-333333333333");

const stableTarget: PreviewTarget = {
  targetId,
  projectId,
  hostId,
  kind: "file",
  opaqueRef: "opaque-token-1" as never,
  displayName: "notes.md",
} as PreviewTarget;

function makeManifest() {
  return {
    target: stableTarget,
    kind: "markdown" as const,
    sourceVersion: decodePreviewSourceVersion({
      contentSha256: "0".repeat(64),
      byteSize: 12,
      observedAt: "2026-07-22T08:00:00.000Z",
    }),
    byteSize: 12,
    fidelity: { level: "full" as const },
    capabilities: {
      canSearch: false,
      canSelect: true,
      canZoom: false,
      canRevealInFinder: false,
      canOpenExternally: false,
      canQuickLook: false,
      canEditInMonaco: false,
    },
    sniffedMediaType: "text/markdown",
    bounds: {},
    producedAt: "2026-07-22T08:00:00.000Z",
  };
}

function readyOutcome(): PreviewOutcome {
  return { kind: "ready", manifest: makeManifest() } as PreviewOutcome;
}

function textChunk(sequence: number, text: string, isFinal: boolean) {
  return {
    chunkId: "66666666-6666-4666-8666-666666666666",
    targetId,
    sourceVersion: makeManifest().sourceVersion,
    kind: "text" as const,
    sequence,
    descriptor: { kind: "text" as const, startLine: sequence + 1, endLine: sequence + 1 },
    payload: { kind: "text" as const, text, encoding: "utf-8" },
    isFinal,
  };
}

function makeClient(overrides: Partial<PreviewClient> = {}): PreviewClient {
  return {
    open: vi.fn(async () => readyOutcome()),
    refresh: vi.fn(async () => readyOutcome()),
    readChunks: vi.fn(
      async () => ({ kind: "chunks", chunks: [] }) as unknown as PreviewChunksReply,
    ),
    cancel: vi.fn(async () => ({ kind: "cancelled" as const })),
    handoff: vi.fn(async () => ({ kind: "done" as const, handoffKind: "open-external" as const })),
    ...overrides,
  } as PreviewClient;
}

describe("usePreviewController", () => {
  it("opens a ready target and streams text chunks to ready", async () => {
    const client = makeClient({
      readChunks: vi.fn(
        async () =>
          ({
            kind: "chunks",
            chunks: [textChunk(0, "hello\n", false), textChunk(1, "world\n", true)],
          }) as unknown as PreviewChunksReply,
      ),
    });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("ready"));
    expect(result.current.model.chunks).toHaveLength(2);
    expect(result.current.model.manifestKind).toBe("markdown");
  });

  it("surfaces unauthorized when open returns unauthorized", async () => {
    const client = makeClient({
      open: vi.fn(async () => ({ kind: "unauthorized", targetId }) as PreviewOutcome),
    });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("unauthorized"));
    expect(result.current.model.canRetry).toBe(false);
  });

  it("surfaces unsupported with canOpenExternally", async () => {
    const client = makeClient({
      open: vi.fn(
        async () =>
          ({
            kind: "unsupported",
            target: stableTarget,
            mediaType: "application/vnd.ms-word",
            canOpenExternally: true,
          }) as PreviewOutcome,
      ),
    });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("unsupported"));
    expect(result.current.model.canOpenExternally).toBe(true);
  });

  it("surfaces too-large with byte size and limit", async () => {
    const client = makeClient({
      open: vi.fn(
        async () =>
          ({
            kind: "too-large",
            target: stableTarget,
            byteSize: 2048,
            limit: 1024,
            canOpenExternally: true,
          }) as PreviewOutcome,
      ),
    });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("too-large"));
    expect(result.current.model.message).toContain("2048");
  });

  it("surfaces failure when open throws a PreviewClientFailure", async () => {
    const client = makeClient({
      open: vi.fn(async () => {
        throw new PreviewClientFailure("Preview request is unauthorized.", 401);
      }),
    });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("unauthorized"));
  });

  it("surfaces interrupted when readChunks is aborted", async () => {
    const client = makeClient({
      readChunks: vi.fn(async (_target, _version, _after, signal) => {
        // Wait for the abort signal, then throw so the controller surfaces
        // interrupted. A real abort arrives via the controller's AbortController.
        return new Promise<PreviewChunksReply>((_, reject) => {
          if (signal?.aborted) {
            reject(new PreviewClientFailure("aborted", 0));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new PreviewClientFailure("aborted", 0));
          });
        });
      }) as unknown as PreviewClient["readChunks"],
    });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("streaming"));
    await act(async () => {
      result.current.cancel();
    });
    await waitFor(() => expect(result.current.model.status).toBe("interrupted"));
    expect(result.current.model.canRetry).toBe(true);
  });

  it("cancels the previous stream when the target changes", async () => {
    let oldSignal: AbortSignal | undefined;
    const client = makeClient({
      readChunks: vi.fn(async (target, _version, _after, signal) => {
        if (target.opaqueRef === stableTarget.opaqueRef) {
          oldSignal = signal;
          return new Promise<PreviewChunksReply>(() => undefined);
        }
        return { kind: "chunks", chunks: [] } as unknown as PreviewChunksReply;
      }) as unknown as PreviewClient["readChunks"],
    });
    const nextTarget = { ...stableTarget, opaqueRef: "opaque-token-2" as never };
    const { result, rerender } = renderHook(
      ({ target }: { target: PreviewTarget }) =>
        usePreviewController({ client, target, enabled: true }),
      { initialProps: { target: stableTarget } },
    );

    await waitFor(() => expect(result.current.model.status).toBe("streaming"));
    await act(async () => {
      rerender({ target: nextTarget });
    });

    await waitFor(() => expect(oldSignal?.aborted).toBe(true));
    expect(client.cancel).toHaveBeenCalledWith(stableTarget);
  });

  it("surfaces stale when readChunks returns stale", async () => {
    const client = makeClient({
      readChunks: vi.fn(
        async () =>
          ({
            kind: "stale",
            target: stableTarget,
            knownVersion: makeManifest().sourceVersion,
          }) as unknown as PreviewChunksReply,
      ),
    });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("stale"));
    expect(result.current.model.canRetry).toBe(true);
  });

  it("returns idle when disabled", async () => {
    const client = makeClient();
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: false }),
    );
    expect(result.current.model.status).toBe("idle");
  });

  it("propagates manifest handoff capabilities on ready", async () => {
    const client = makeClient({
      open: vi.fn(async () => {
        const manifest = makeManifest();
        return {
          kind: "ready",
          manifest: {
            ...manifest,
            capabilities: {
              ...manifest.capabilities,
              canRevealInFinder: true,
              canQuickLook: true,
              canOpenExternally: true,
            },
          },
        } as PreviewOutcome;
      }),
    });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("ready"));
    expect(result.current.model.canRevealInFinder).toBe(true);
    expect(result.current.model.canQuickLook).toBe(true);
    expect(result.current.model.canOpenExternally).toBe(true);
  });

  it("calls previewClient.handoff and surfaces a path-free done message", async () => {
    const handoff = vi.fn(async () => ({
      kind: "done" as const,
      handoffKind: "reveal-in-finder" as const,
    }));
    const client = makeClient({ handoff });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("ready"));
    await act(async () => {
      await result.current.handoff("reveal-in-finder");
    });
    expect(handoff).toHaveBeenCalledWith(stableTarget, "reveal-in-finder", expect.any(AbortSignal));
    expect(result.current.handoffMessage).toBe("Revealed in Finder.");
    expect(result.current.handoffPending).toBe(false);
  });

  it("fails closed on unauthorized handoff replies without disclosing a path", async () => {
    const handoff = vi.fn(async () => ({
      kind: "unauthorized" as const,
      targetId,
    }));
    const client = makeClient({ handoff });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("ready"));
    await act(async () => {
      await result.current.handoff("open-external");
    });
    expect(result.current.handoffMessage).toBe("Octant could not complete the preview handoff.");
    expect(result.current.handoffMessage).not.toMatch(/\//);
  });

  it("cancels an in-flight handoff and ignores superseded completion", async () => {
    let resolveHandoff!: (value: {
      readonly kind: "done";
      readonly handoffKind: "open-external";
    }) => void;
    const handoff = vi.fn(
      (_target, _kind, signal?: AbortSignal) =>
        new Promise<{ readonly kind: "done"; readonly handoffKind: "open-external" }>(
          (resolve, reject) => {
            resolveHandoff = resolve;
            signal?.addEventListener("abort", () => {
              reject(new PreviewClientFailure("aborted", 0));
            });
          },
        ),
    );
    const client = makeClient({ handoff });
    const { result } = renderHook(() =>
      usePreviewController({ client, target: stableTarget, enabled: true }),
    );
    await waitFor(() => expect(result.current.model.status).toBe("ready"));

    let firstDone = false;
    await act(async () => {
      void result.current.handoff("open-external").then(() => {
        firstDone = true;
      });
    });
    await waitFor(() => expect(result.current.handoffPending).toBe(true));

    await act(async () => {
      result.current.cancelHandoff();
    });
    expect(result.current.handoffPending).toBe(false);
    expect(result.current.handoffMessage).toBe("Handoff cancelled.");

    await act(async () => {
      resolveHandoff({ kind: "done", handoffKind: "open-external" });
      await Promise.resolve();
    });
    expect(firstDone).toBe(true);
    expect(result.current.handoffMessage).toBe("Handoff cancelled.");
  });
});
