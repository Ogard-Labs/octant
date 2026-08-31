import { act, render } from "@testing-library/react";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratedImageList } from "./GeneratedImageList";

const scopeId = "a3000000-0000-4000-8000-000000000002" as never;

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
});
