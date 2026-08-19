import type { ShipClient } from "@octant/client-runtime/ship-client";
import type { ShipTarget } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ShipPanel } from "./ShipPanel";

const threadId = "00000000-0000-4000-8000-000000000701";
const targetId = "00000000-0000-4000-8000-000000000702";

const target = {
  id: targetId,
  extensionId: "ship-to-a-branch",
  displayName: "Public site",
  destination: {
    kind: "git-branch",
    remoteName: "origin",
    branch: "published",
    artifactDirectory: "dist",
  },
  enabled: true,
  credentialReference: "credential/site",
  version: 2,
  updatedAt: "2026-08-19T09:00:00.000Z",
} as unknown as ShipTarget;

function client(overrides: Partial<ShipClient> = {}): ShipClient {
  return {
    targets: vi.fn(async () => [target]),
    execute: vi.fn(async () => ({
      kind: "ship-plan",
      plan: {
        targetId,
        targetName: "Public site",
        destination: target.destination,
        revision: "1".repeat(40),
        artifactDigest: `sha256:${"a".repeat(64)}`,
        producedByRunId: "run-1",
      },
    })),
    ...overrides,
  } as unknown as ShipClient;
}

describe("publishing to somewhere you own", () => {
  it("says Octant runs no target of its own and routes nothing through itself", async () => {
    render(<ShipPanel client={client()} threadId={threadId} />);

    expect(await screen.findByText(/runs none of its own/i)).toBeVisible();
    expect(screen.getByText(/Nothing is routed\s+through Octant/i)).toBeVisible();
  });

  it("names the revision and the exact place before anyone approves anything", async () => {
    render(<ShipPanel client={client()} threadId={threadId} />);
    await screen.findByText("Public site");

    await userEvent.click(screen.getByRole("button", { name: "Review publication" }));

    await waitFor(() =>
      expect(screen.getByText(/Publish 111111111111 to origin\/published/)).toBeVisible(),
    );
    expect(screen.getByText(/no checkpoint here/i)).toBeVisible();
  });

  it("shows the host's refusal rather than pretending the publication happened", async () => {
    const shipClient = client({
      execute: vi.fn(async () => ({
        kind: "ship-refused",
        reason: "revision-not-reviewed",
        message: "This is not the revision that was reviewed.",
      })) as unknown as ShipClient["execute"],
    });
    render(<ShipPanel client={shipClient} threadId={threadId} />);
    await screen.findByText("Public site");

    await userEvent.click(screen.getByRole("button", { name: "Review publication" }));

    await waitFor(() =>
      expect(screen.getByText("This is not the revision that was reviewed.")).toBeVisible(),
    );
  });

  it("says an installed target grants nothing until it is enabled and bound", async () => {
    render(
      <ShipPanel
        client={client({ targets: vi.fn(async () => []) as unknown as ShipClient["targets"] })}
        threadId={threadId}
      />,
    );

    expect(await screen.findByText(/installing one grants it nothing/i)).toBeVisible();
  });

  it("renders nothing at all on a host with no ship surface", () => {
    const { container } = render(<ShipPanel threadId={threadId} />);

    expect(container.firstChild).toBeNull();
  });
});
