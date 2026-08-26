import { renderHook, waitFor } from "@testing-library/react";
import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import { decodeAppleArtifactRequest } from "@octant/contracts/apple-toolchain-rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppleSimulatorScreen } from "./useAppleSimulatorScreen";

const authority = {
  hostId: "4f70656e-4f72-4269-9474-4c6f63616c31",
  mode: "code",
  projectId: "80000000-0000-4000-8000-000000000001",
  providerInstanceId: "80000000-0000-4000-8000-000000000002",
  extension: { kind: "core" },
} as const;

function request(reference: string) {
  return decodeAppleArtifactRequest({
    kind: "apple-artifact-request",
    authority,
    threadId: "80000000-0000-4000-8000-000000000005",
    checkoutId: "80000000-0000-4000-8000-000000000006",
    reference,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAppleSimulatorScreen", () => {
  it("keeps a settled screenshot until its evidence reference changes", async () => {
    const readScreenshot = vi.fn(async () => ({
      status: "succeeded" as const,
      blob: new Blob(["png"], { type: "image/png" }),
    }));
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const client: AppleToolchainClient = {
      discover: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
      snapshot: vi.fn(),
      readScreenshot,
    };
    const firstRequest = request("apple-screenshot-1");
    const { result, rerender } = renderHook(
      ({ artifactRequest }) =>
        useAppleSimulatorScreen({ client, enabled: true, request: artifactRequest }),
      { initialProps: { artifactRequest: firstRequest } },
    );

    await waitFor(() => expect(result.current).toBe("blob:first"));
    rerender({ artifactRequest: firstRequest });
    expect(readScreenshot).toHaveBeenCalledTimes(1);

    rerender({ artifactRequest: request("apple-screenshot-2") });
    await waitFor(() => expect(result.current).toBe("blob:second"));
    expect(readScreenshot).toHaveBeenCalledTimes(2);
  });
});
