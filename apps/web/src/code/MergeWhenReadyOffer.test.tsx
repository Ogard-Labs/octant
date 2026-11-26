import { decodeProjectId } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MergeWhenReadyOffer, type MergeWhenReadyOfferClient } from "./MergeWhenReadyOffer";

const target = {
  projectId: decodeProjectId("00000000-0000-4000-8000-000000000901"),
  repositoryOwner: "acme",
  repositoryName: "app",
  number: 9,
};

describe("MergeWhenReadyOffer", () => {
  it("turns on Merge when ready only when the person confirms, for the head read at that moment", async () => {
    const setProjectPullRequestMergeWhenReady = vi.fn(async () => ({ status: "applied" }) as never);
    const client = {
      queryProjectPullRequestDetail: vi.fn(
        async () => ({ detail: { state: "observed", headSha: "abc123" } }) as never,
      ),
      setProjectPullRequestMergeWhenReady,
    } satisfies MergeWhenReadyOfferClient;
    render(<MergeWhenReadyOffer client={client} target={target} />);

    await userEvent.click(screen.getByRole("button", { name: "Merge acme/app#9 when ready" }));
    expect(setProjectPullRequestMergeWhenReady).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));

    await waitFor(() =>
      expect(setProjectPullRequestMergeWhenReady).toHaveBeenCalledWith({
        kind: "enable",
        target,
        headSha: "abc123",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Merge when ready is on for acme/app#9.",
    );
  });
});
