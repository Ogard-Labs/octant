import type { CanvasExportOfferList } from "@octant/contracts/canvas-export";
import { decodeCanvasExportFolderView } from "@octant/contracts/canvas-export-folder";
import { decodeFolderBrowseResult } from "@octant/contracts/folder-browse";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasExportPanel } from "./CanvasExportPanel";

const canvasId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const approvalId = "44444444-4444-4444-8444-444444444444";

function offers(): CanvasExportOfferList {
  return {
    schemaVersion: 1,
    kind: "canvas-export-offers",
    canvasId: canvasId as CanvasExportOfferList["canvasId"],
    versionId: versionId as CanvasExportOfferList["versionId"],
    sequence: 1,
    targets: [
      {
        targetId: "reading-copy" as CanvasExportOfferList["targets"][number]["targetId"],
        label: "Reading copy",
        formats: ["markdown"],
        status: "ready",
      },
      {
        targetId: "archive-copy" as CanvasExportOfferList["targets"][number]["targetId"],
        label: "Archive copy",
        formats: ["markdown"],
        status: "not-connected",
        message: "This destination is not connected.",
      },
    ],
  };
}

describe("CanvasExportPanel", () => {
  it("shows the rendered payload and the destination before anything is sent", async () => {
    const user = userEvent.setup();
    const onPrepare = vi.fn(async () => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1 as const,
        kind: "canvas-export-approval" as const,
        approvalId: approvalId as CanvasExportOfferList["canvasId"],
        canvasId: canvasId as CanvasExportOfferList["canvasId"],
        versionId: versionId as CanvasExportOfferList["versionId"],
        sequence: 1,
        targetId: "reading-copy" as CanvasExportOfferList["targets"][number]["targetId"],
        destinationLabel: "Reading copy",
        format: "markdown" as const,
        title: "Launch plan",
        payload: "# Launch plan\n",
        payloadDigest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as CanvasExportOfferList["targets"][number]["targetId"],
        byteLength: 15,
      },
    }));
    const onDecide = vi.fn();
    render(
      <CanvasExportPanel
        offers={offers()}
        onDecide={onDecide as never}
        onPrepare={onPrepare as never}
      />,
    );

    expect(screen.getByText("Not connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review export" }));

    expect(onDecide).not.toHaveBeenCalled();
    expect(await screen.findByText("Export to Reading copy")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-export-payload")).toHaveTextContent("# Launch plan");
  });

  it("says a delivered export could not be recorded instead of reporting a failure", async () => {
    const user = userEvent.setup();
    const onPrepare = vi.fn(async () => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1 as const,
        kind: "canvas-export-approval" as const,
        approvalId,
        canvasId,
        versionId,
        sequence: 1,
        targetId: "reading-copy",
        destinationLabel: "Reading copy",
        format: "markdown" as const,
        title: "Launch plan",
        payload: "# Launch plan\n",
        payloadDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        byteLength: 15,
      },
    }));
    const onDecide = vi.fn(async () => ({
      kind: "unrecorded" as const,
      outcome: {
        kind: "receipt" as const,
        receipt: { kind: "remote-id" as const, remoteId: "copy-1" },
      },
      message: "The export was delivered, but this host could not record it.",
    }));
    render(
      <CanvasExportPanel
        offers={offers()}
        onDecide={onDecide as never}
        onPrepare={onPrepare as never}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review export" }));
    await user.click(await screen.findByRole("button", { name: "Approve export" }));

    expect(await screen.findByText(/Exported\. copy-1/)).toHaveTextContent(
      "The export was delivered, but this host could not record it.",
    );
  });

  it("says when no destination is ready", () => {
    render(
      <CanvasExportPanel
        offers={{ ...offers(), targets: [] }}
        onDecide={vi.fn()}
        onPrepare={vi.fn()}
      />,
    );

    expect(screen.getByTestId("canvas-export-empty")).toHaveTextContent(
      "No export destination is installed yet.",
    );
  });

  it("names the file the export will write, and says when it replaces one", async () => {
    const user = userEvent.setup();
    const onPrepare = vi.fn(async () => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1 as const,
        kind: "canvas-export-approval" as const,
        approvalId,
        canvasId,
        versionId,
        sequence: 1,
        targetId: "folder-on-this-mac",
        destinationLabel: "A folder on this computer",
        format: "markdown" as const,
        title: "Launch plan",
        destinationPath: "/Users/henrik/Documents/Exports/Launch plan.md",
        replacesExisting: true,
        payload: "# Launch plan\n",
        payloadDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        byteLength: 15,
      },
    }));
    render(
      <CanvasExportPanel offers={offers()} onDecide={vi.fn()} onPrepare={onPrepare as never} />,
    );

    await user.click(screen.getByRole("button", { name: "Review export" }));

    expect(await screen.findByTestId("canvas-export-destination")).toHaveTextContent(
      "Replaces /Users/henrik/Documents/Exports/Launch plan.md",
    );
  });

  it("says on the card when the export writes design markup as written, and not otherwise", async () => {
    const user = userEvent.setup();
    const card = (writesDesignMarkup: boolean) => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1 as const,
        kind: "canvas-export-approval" as const,
        approvalId,
        canvasId,
        versionId,
        sequence: 1,
        targetId: "folder-on-this-mac",
        destinationLabel: "A folder on this computer",
        format: "html" as const,
        title: "Cart",
        ...(writesDesignMarkup ? { writesDesignMarkup: true as const } : {}),
        payload: "<!DOCTYPE html><html></html>\n",
        payloadDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        byteLength: 29,
      },
    });
    const withMarkup = render(
      <CanvasExportPanel
        offers={offers()}
        onDecide={vi.fn()}
        onPrepare={vi.fn(async () => card(true)) as never}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Review export" }));
    expect(await screen.findByTestId("canvas-export-design-markup")).toHaveTextContent(
      "This Canvas's design markup leaves as written.",
    );
    withMarkup.unmount();

    render(
      <CanvasExportPanel
        offers={offers()}
        onDecide={vi.fn()}
        onPrepare={vi.fn(async () => card(false)) as never}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Review export" }));
    expect(await screen.findByRole("button", { name: "Approve export" })).toBeVisible();
    expect(screen.queryByTestId("canvas-export-design-markup")).toBeNull();
  });

  it("shows the chosen folder and sends back the candidate the host listed", async () => {
    const user = userEvent.setup();
    const candidateId = "88888888-8888-4888-8888-888888888888";
    const choose = vi.fn(async () => true);
    const onExportFolderChosen = vi.fn();
    render(
      <CanvasExportPanel
        folder={{
          view: decodeCanvasExportFolderView({
            kind: "canvas-export-folder-view",
            settings: {
              kind: "canvas-export-folder-settings",
              overrides: [],
              version: 0,
              updatedAt: "2026-08-01T21:00:00.000Z",
            },
            scope: "project",
            hostId: "local",
            mode: "work",
          }),
          busy: false,
          message: undefined,
          browse: async () =>
            decodeFolderBrowseResult({
              candidates: [
                {
                  candidateId,
                  displayName: "Exports",
                  isGitRepository: false,
                  isSelectable: true,
                },
              ],
              breadcrumbs: [{ label: "henrik" }],
              hasMore: false,
              browsedAt: "2026-08-01T21:00:00.000Z",
            }),
          choose,
        }}
        offers={offers()}
        onDecide={vi.fn()}
        onExportFolderChosen={onExportFolderChosen}
        onPrepare={vi.fn()}
      />,
    );

    expect(screen.getByTestId("canvas-export-folder")).toHaveTextContent("No folder chosen yet");

    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    await user.click(await screen.findByRole("button", { name: "Select" }));

    expect(choose).toHaveBeenCalledWith(candidateId);
    expect(onExportFolderChosen).toHaveBeenCalled();
  });

  it("shows the account and the public note, and sends the audience the person chose", async () => {
    const user = userEvent.setup();
    const onPrepare = vi.fn(async () => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1 as const,
        kind: "canvas-export-approval" as const,
        approvalId,
        canvasId,
        versionId,
        sequence: 1,
        targetId: "github-gist",
        destinationLabel: "GitHub Gist",
        format: "markdown" as const,
        title: "Launch plan",
        destinationAccount: "octocat",
        destinationVisibility: "secret" as const,
        destinationNote: "A public gist is visible to anyone on the internet.",
        payload: "# Launch plan\n",
        payloadDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        byteLength: 15,
      },
    }));
    const onDecide = vi.fn(async () => ({
      kind: "denied" as const,
      message: "Export was not approved.",
    }));
    render(
      <CanvasExportPanel
        offers={offers()}
        onDecide={onDecide as never}
        onPrepare={onPrepare as never}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review export" }));

    expect(await screen.findByTestId("canvas-export-account")).toHaveTextContent(
      "Posts as octocat",
    );
    expect(screen.getByTestId("canvas-export-note")).toHaveTextContent("visible to anyone");

    await user.click(screen.getByRole("combobox", { name: "Who can see this export" }));
    // A secret gist is unlisted, not private: anyone holding its URL can read it.
    expect(
      await screen.findByRole("option", { name: "Secret — anyone with the link" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Public — visible to anyone" }));
    await user.click(screen.getByRole("button", { name: "Approve export" }));

    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ visibility: "public" }));
  });

  describe("a public link destination", () => {
    const linkOffers = (): CanvasExportOfferList => ({
      ...offers(),
      targets: [
        ...offers().targets,
        {
          targetId: "public-link" as CanvasExportOfferList["targets"][number]["targetId"],
          label: "Public link",
          formats: ["share-document"],
          status: "ready",
        },
      ],
    });
    const linkCard = (terms: Record<string, unknown>) => ({
      kind: "approval" as const,
      card: {
        schemaVersion: 1 as const,
        kind: "canvas-export-approval" as const,
        approvalId,
        canvasId,
        versionId,
        sequence: 1,
        targetId: "public-link",
        destinationLabel: "Public link",
        format: "share-document" as const,
        title: "Launch plan",
        destinationLinkTerms: terms,
        payload: "{}",
        payloadDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        byteLength: 2,
      },
    });
    const refused = async () => ({ kind: "refused" as const, message: "Not sent." });

    it("shows the link terms with the default expiry chosen and never expiring left unchosen", async () => {
      const user = userEvent.setup();
      render(
        <CanvasExportPanel
          initialTargetId="public-link"
          offers={linkOffers()}
          onDecide={vi.fn()}
          onPrepare={
            vi.fn(async () =>
              linkCard({
                defaultExpiryDays: 30,
                allowsPassword: true,
                updatesLink: "https://canvas.octant.sh/s/abc",
                hasPassword: true,
              }),
            ) as never
          }
        />,
      );
      await user.click(screen.getByRole("button", { name: "Review export" }));

      expect(await screen.findByText("The link opens for anyone who has it.")).toBeVisible();
      expect(screen.getByTestId("canvas-export-updates-link")).toHaveTextContent(
        "Updates https://canvas.octant.sh/s/abc",
      );
      expect(screen.getByRole("combobox", { name: "Link expires" })).toHaveTextContent("30 days");
      expect(screen.getByText(/keeps it unless you enter a new one/)).toBeVisible();
      expect(screen.getByTestId("canvas-export-link-password")).toHaveAttribute("type", "password");
    });

    it("sends the chosen expiry and password when the person approves", async () => {
      const user = userEvent.setup();
      const onDecide = vi.fn(refused);
      render(
        <CanvasExportPanel
          initialTargetId="public-link"
          offers={linkOffers()}
          onDecide={onDecide as never}
          onPrepare={
            vi.fn(async () => linkCard({ defaultExpiryDays: 30, allowsPassword: true })) as never
          }
        />,
      );
      await user.click(screen.getByRole("button", { name: "Review export" }));
      await user.click(await screen.findByRole("combobox", { name: "Link expires" }));
      await user.click(await screen.findByRole("option", { name: "7 days" }));
      await user.type(screen.getByTestId("canvas-export-link-password"), "correct horse");
      await user.click(screen.getByRole("button", { name: "Approve export" }));

      expect(onDecide).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "approved",
          link: { expiry: { kind: "days", days: 7 }, password: "correct horse" },
        }),
      );
    });

    it("sends the destination's default expiry and no password when the person changes nothing", async () => {
      const user = userEvent.setup();
      const onDecide = vi.fn(refused);
      render(
        <CanvasExportPanel
          initialTargetId="public-link"
          offers={linkOffers()}
          onDecide={onDecide as never}
          onPrepare={
            vi.fn(async () => linkCard({ defaultExpiryDays: 30, allowsPassword: true })) as never
          }
        />,
      );
      await user.click(screen.getByRole("button", { name: "Review export" }));
      await user.click(await screen.findByRole("button", { name: "Approve export" }));

      expect(onDecide).toHaveBeenCalledWith(
        expect.objectContaining({ link: { expiry: { kind: "days", days: 30 } } }),
      );
    });

    it("refuses a password that is too short before anything is sent", async () => {
      const user = userEvent.setup();
      const onDecide = vi.fn(refused);
      render(
        <CanvasExportPanel
          initialTargetId="public-link"
          offers={linkOffers()}
          onDecide={onDecide as never}
          onPrepare={
            vi.fn(async () => linkCard({ defaultExpiryDays: 30, allowsPassword: true })) as never
          }
        />,
      );
      await user.click(screen.getByRole("button", { name: "Review export" }));
      await user.type(await screen.findByTestId("canvas-export-link-password"), "short");
      await user.click(screen.getByRole("button", { name: "Approve export" }));

      expect(onDecide).not.toHaveBeenCalled();
      expect(screen.getByRole("status")).toHaveTextContent("at least 8 characters");
    });

    it("preselects the destination it was opened for", () => {
      render(
        <CanvasExportPanel
          initialTargetId="public-link"
          offers={linkOffers()}
          onDecide={vi.fn()}
          onPrepare={vi.fn()}
        />,
      );

      expect(screen.getByRole("combobox", { name: "Destination" })).toHaveTextContent(
        "Public link",
      );
    });
  });
});
