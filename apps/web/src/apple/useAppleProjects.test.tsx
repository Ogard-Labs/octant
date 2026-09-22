import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts";
import type { CodeFileListingClient } from "@octant/client-runtime";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppleProjects } from "./useAppleProjects";

const threadId = "c5b0e039-ee21-40cb-a8b7-7c8d6da68354" as CodeThreadId;
const checkoutId = "c86ab8b6-7cd4-4ecf-8ea8-bbcd78bfabce" as CodeCheckoutId;

function listingClient() {
  const list = vi.fn(async (): Promise<unknown> => ({
    status: "listed" as const,
    listing: {
      kind: "code-file-listing" as const,
      threadId,
      checkoutId,
      entries: [
        { kind: "directory" as const, path: "SimulatorFixture" },
        { kind: "directory" as const, path: "SimulatorFixture.xcodeproj" },
        { kind: "directory" as const, path: "SimulatorFixture.xcodeproj/project.xcworkspace" },
        { kind: "directory" as const, path: "SimulatorFixtureTests" },
      ],
      truncated: false,
    },
  }));
  const client = {
    list,
    watch: vi.fn(),
    search: vi.fn(),
  } as unknown as CodeFileListingClient;
  return { client, list };
}

describe("useAppleProjects", () => {
  it("lists while the view still reports the checkout waiting, and names the Xcode project at the root", async () => {
    // Observed 2026-09-19: after a relaunch the thread view kept reporting
    // the checkout waiting although the listing endpoint resolved it fine —
    // gating on that answer hid the Simulator tool and the workbench palette
    // entry for the life of the view.
    const { client, list } = listingClient();
    const { result } = renderHook(
      (props: { readonly availability: "waiting" | "available" }) =>
        useAppleProjects({
          client,
          threadId,
          checkoutId,
          checkoutAvailability: props.availability,
        }),
      { initialProps: { availability: "waiting" } },
    );

    await waitFor(() =>
      expect(result.current).toEqual([
        { projectPath: "SimulatorFixture.xcodeproj", name: "SimulatorFixture.xcodeproj" },
      ]),
    );
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("retries a listing refused while the checkout was waiting once the view reports it available", async () => {
    // The failure the original availability gate was added for: a one-shot
    // read taken while the host resolves the checkout keeps its refusal for
    // the life of the view. The retry is what replaces the gate.
    const { client, list } = listingClient();
    list.mockResolvedValueOnce({
      status: "failed",
      failure: { category: "unavailable", message: "Code checkout is unavailable." },
    });
    const { result, rerender } = renderHook(
      (props: { readonly availability: "waiting" | "available" }) =>
        useAppleProjects({
          client,
          threadId,
          checkoutId,
          checkoutAvailability: props.availability,
        }),
      { initialProps: { availability: "waiting" } },
    );

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual([]);

    rerender({ availability: "available" });

    await waitFor(() =>
      expect(result.current).toEqual([
        { projectPath: "SimulatorFixture.xcodeproj", name: "SimulatorFixture.xcodeproj" },
      ]),
    );
    expect(list).toHaveBeenCalledTimes(2);
  });
});
