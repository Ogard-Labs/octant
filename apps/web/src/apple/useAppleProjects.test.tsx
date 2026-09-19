import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts";
import type { CodeFileListingClient } from "@octant/client-runtime";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppleProjects } from "./useAppleProjects";

const threadId = "c5b0e039-ee21-40cb-a8b7-7c8d6da68354" as CodeThreadId;
const checkoutId = "c86ab8b6-7cd4-4ecf-8ea8-bbcd78bfabce" as CodeCheckoutId;

function listingClient() {
  const list = vi.fn(async () => ({
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
  it("waits for the checkout to be available before listing, then names the Xcode project at the root", async () => {
    // Observed 2026-09-19: the first listing after a thread opens answered
    // 503 "Code checkout is unavailable" (waiting) and, being a one-shot read,
    // was never repeated — so the Simulator tool and the workbench palette
    // entry stayed hidden although Files listed the .xcodeproj seconds later.
    const { client, list } = listingClient();
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(list).not.toHaveBeenCalled();
    expect(result.current).toEqual([]);

    rerender({ availability: "available" });

    await waitFor(() =>
      expect(result.current).toEqual([
        { projectPath: "SimulatorFixture.xcodeproj", name: "SimulatorFixture.xcodeproj" },
      ]),
    );
    expect(list).toHaveBeenCalledTimes(1);
  });
});
