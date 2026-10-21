import type { CanvasId } from "@octant/contracts/canvas";
import type {
  CanvasPublicShareList,
  CanvasPublicShareRecord,
} from "@octant/contracts/canvas-public-share";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasPublicLinksSection } from "./CanvasPublicLinksSection";

const canvasId = "11111111-1111-4111-8111-111111111111" as CanvasId;
const shareId = "AAAAAAAAAAAAAAAAAAAAAA";

function record(overrides: Record<string, unknown> = {}): CanvasPublicShareRecord {
  return {
    publicShareId: shareId,
    canvasId,
    url: "https://canvas.octant.sh/s/AAAAAAAAAAAAAAAAAAAAAA",
    serviceUrl: "https://canvas.octant.sh",
    versionId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    publishedAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    expiresAt: null,
    passwordProtected: true,
    status: "active",
    ...overrides,
  } as unknown as CanvasPublicShareRecord;
}

function list(
  shares: ReadonlyArray<CanvasPublicShareRecord>,
  enabled = true,
): CanvasPublicShareList {
  return {
    schemaVersion: 1,
    kind: "canvas-public-share-list",
    canvasId,
    enabled,
    serviceUrl: "https://canvas.octant.sh",
    shares,
  } as unknown as CanvasPublicShareList;
}

describe("CanvasPublicLinksSection", () => {
  it("lists each link with its status, expiry, and password badge", async () => {
    render(
      <CanvasPublicLinksSection
        canvasId={canvasId}
        onList={vi.fn(async () => list([record()]))}
        onRevoke={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    const row = await screen.findByTestId(`canvas-public-link-${shareId}`);
    expect(row).toHaveTextContent("https://canvas.octant.sh/s/AAAAAAAAAAAAAAAAAAAAAA");
    expect(row).toHaveTextContent("Active");
    expect(row).toHaveTextContent("Never expires");
    expect(row).toHaveTextContent("Password");
  });

  it("copies the link address to the clipboard", async () => {
    const user = userEvent.setup();
    const copyText = vi.fn(async () => undefined);
    render(
      <CanvasPublicLinksSection
        canvasId={canvasId}
        copyText={copyText}
        onList={vi.fn(async () => list([record()]))}
        onRevoke={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Copy link" }));

    expect(copyText).toHaveBeenCalledWith("https://canvas.octant.sh/s/AAAAAAAAAAAAAAAAAAAAAA");
    expect(await screen.findByText("Link copied.")).toBeVisible();
  });

  it("opens the export dialog when the person chooses Update", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(
      <CanvasPublicLinksSection
        canvasId={canvasId}
        onList={vi.fn(async () => list([record()]))}
        onRevoke={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Update" }));

    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("asks before revoking and then asks the host to revoke that link", async () => {
    const user = userEvent.setup();
    const onRevoke = vi.fn(async () => ({
      kind: "revoked" as const,
      share: record({ status: "revoked" }),
    }));
    const onList = vi
      .fn<() => Promise<CanvasPublicShareList>>()
      .mockResolvedValueOnce(list([record()]))
      .mockResolvedValue(list([record({ status: "revoked" })]));
    render(
      <CanvasPublicLinksSection
        canvasId={canvasId}
        onList={onList}
        onRevoke={onRevoke as never}
        onUpdate={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(onRevoke).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Revoke link" }));

    await waitFor(() =>
      expect(onRevoke).toHaveBeenCalledWith({
        schemaVersion: 1,
        kind: "canvas-public-share-revoke",
        canvasId,
        publicShareId: shareId,
      }),
    );
    expect(await screen.findByText("Link revoked. It no longer opens.")).toBeVisible();
    expect(screen.getByTestId(`canvas-public-link-${shareId}`)).toHaveTextContent("Revoked");
  });

  it("says plainly when the service could not confirm a revocation yet", async () => {
    const user = userEvent.setup();
    const onRevoke = vi.fn(async () => ({
      kind: "revoking" as const,
      share: record({ status: "revoking" }),
      message: "The service could not be reached. This host will keep trying.",
    }));
    const onList = vi
      .fn<() => Promise<CanvasPublicShareList>>()
      .mockResolvedValueOnce(list([record()]))
      .mockResolvedValue(list([record({ status: "revoking" })]));
    render(
      <CanvasPublicLinksSection
        canvasId={canvasId}
        onList={onList}
        onRevoke={onRevoke as never}
        onUpdate={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await user.click(await screen.findByRole("button", { name: "Revoke link" }));

    expect(
      await screen.findByText("The service could not be reached. This host will keep trying."),
    ).toBeVisible();
    expect(screen.getByTestId(`canvas-public-link-${shareId}`)).toHaveTextContent("Revoking");
    expect(screen.getByTestId(`canvas-public-link-${shareId}`)).toHaveTextContent("may still open");
  });

  it("points to Settings when public links are off and none exist", async () => {
    render(
      <CanvasPublicLinksSection
        canvasId={canvasId}
        onList={vi.fn(async () => list([], false))}
        onRevoke={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("canvas-public-links-off")).toHaveTextContent(
      "Settings › Data & privacy › Public links",
    );
  });
});
