import { act, render, screen } from "@testing-library/react";
import type { ImageJob } from "@octant/contracts";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratedImageList } from "./GeneratedImageList";

const scopeId = "a3000000-0000-4000-8000-000000000002" as never;
const nextScopeId = "a3000000-0000-4000-8000-000000000003" as never;

function queuedJob(jobScopeId: typeof scopeId): ImageJob {
  return {
    id: "a3000000-0000-4000-8000-000000000004" as never,
    status: "queued",
    threadKind: "chat-thread",
    scopeId: jobScopeId,
    profileInstanceId: "a3000000-0000-4000-8000-000000000005" as never,
    modelId: "image-model" as never,
    promptHash: "a".repeat(64),
    artifacts: [],
    version: 1 as never,
    createdAt: "2026-08-31T00:00:00.000Z" as never,
    updatedAt: "2026-08-31T00:00:00.000Z" as never,
  };
}

describe("GeneratedImageList polling", () => {
  afterEach(() => vi.useRealTimers());

  it("does not overlap a slow generated-image list request", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: { readonly jobs: [] }) => void) | undefined;
    const list = vi.fn(
      () =>
        new Promise<{ readonly jobs: [] }>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const client = { list } as unknown as ImageGenerationClient;
    render(
      <GeneratedImageList
        client={client}
        profiles={[]}
        scopeId={scopeId}
        threadKind="chat-thread"
      />,
    );

    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirst?.({ jobs: [] }));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("clears the previous scope and starts the next generation while an old poll is pending", async () => {
    vi.useFakeTimers();
    let resolveInitial: ((value: { readonly jobs: ReadonlyArray<ImageJob> }) => void) | undefined;
    let resolveOldPoll: ((value: { readonly jobs: ReadonlyArray<ImageJob> }) => void) | undefined;
    let resolveNextScope: ((value: { readonly jobs: ReadonlyArray<ImageJob> }) => void) | undefined;
    const list = vi.fn(
      ({
        scopeId: requestedScopeId,
        threadKind: requestedThreadKind,
      }: {
        readonly scopeId: unknown;
        readonly threadKind: string;
      }) => {
        if (
          requestedScopeId === scopeId &&
          requestedThreadKind === "chat-thread" &&
          list.mock.calls.length === 1
        ) {
          return new Promise<{ readonly jobs: ReadonlyArray<ImageJob> }>((resolve) => {
            resolveInitial = resolve;
          });
        }
        if (requestedScopeId === scopeId && requestedThreadKind === "chat-thread") {
          return new Promise<{ readonly jobs: ReadonlyArray<ImageJob> }>((resolve) => {
            resolveOldPoll = resolve;
          });
        }
        return new Promise<{ readonly jobs: ReadonlyArray<ImageJob> }>((resolve) => {
          resolveNextScope = resolve;
        });
      },
    );
    const client = { list } as unknown as ImageGenerationClient;
    const view = render(
      <GeneratedImageList
        client={client}
        profiles={[]}
        scopeId={scopeId}
        threadKind="chat-thread"
      />,
    );

    await act(async () => resolveInitial?.({ jobs: [queuedJob(scopeId)] }));
    expect(screen.getByText("Image queued…")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(list).toHaveBeenCalledTimes(2);

    view.rerender(
      <GeneratedImageList
        client={client}
        profiles={[]}
        scopeId={nextScopeId}
        threadKind="code-thread"
      />,
    );
    expect(list).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("Image queued…")).not.toBeInTheDocument();

    await act(async () => resolveOldPoll?.({ jobs: [queuedJob(scopeId)] }));
    expect(screen.queryByText("Image queued…")).not.toBeInTheDocument();

    await act(async () => resolveNextScope?.({ jobs: [queuedJob(nextScopeId)] }));
    expect(screen.getByText("Image queued…")).toBeInTheDocument();
  });
});
