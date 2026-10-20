import {
  decodeCanvasExportContribution,
  decodeCanvasExportDelivery,
  decodeCanvasExportReceipt,
  type CanvasExportDelivery,
  type CanvasExportRefusal,
} from "@octant/contracts/canvas-export";
import { isCanvasShareSafeText } from "@octant/contracts/canvas-share";
import { canvasExportPlannedName } from "@octant/domain";
import type {
  CanvasExportHostPorts,
  CanvasExportTargetFactory,
} from "@octant/plugin-api/canvas-export";
import type { PagePublisherOffer } from "@octant/plugin-api/page-publishing";

/**
 * Sharing a rendered Canvas as a private page on the person's own account with
 * a provider.
 *
 * This rides the same published export port the folder and gist destinations
 * do: it declares a contribution, describes what the person is approving, and
 * is called only after approval. It is built from the host's ports alone, as a
 * plugin's contribution would be: it asks the page-publishing port which
 * enabled provider instances can publish pages and publishes through the first
 * one listed, and it never learns which provider, runtime, or tool answers —
 * no adapter, no credential, no vendor name. The destination is labelled after
 * that instance's display name, so it reads "Share to" and the name the person
 * gave the account in Settings.
 *
 * HTML only: the page is the rendered document as the person saw it on the
 * card. The rendered HTML passes the same path-and-secret filter every
 * external export does, so a document that still carries one is refused rather
 * than published. Each share makes a new page, and the card says so.
 */

export const PAGE_EXPORT_TARGET_ID = "provider-page";

/** The destination's label, after the account it publishes through. */
export function pageExportTargetLabel(publisher: string): string {
  return `Share to ${publisher}`;
}

/** The note the card shows, so the person knows who can open the page and that a share never replaces one. */
export function pageExportNote(publisher: string): string {
  return `Publishes the HTML as a private page on your ${publisher} account. Only you can open it until you share it there. Each share makes a new page.`;
}

/** The label the contribution carries while no instance can publish, so it is never listed under it. */
const UNLISTED_LABEL = "Share as a page";
const NO_PUBLISHER = "No account that can publish pages is available.";
const NOT_SIGNED_IN = "The account that publishes pages is not signed in.";

function refused(code: CanvasExportRefusal["code"], message: string): CanvasExportDelivery {
  return { kind: "refused", code, message };
}

/**
 * The instance this destination publishes through: the first the port lists.
 * The port lists only enabled instances whose runtime is ready and whose
 * driver publishes pages, so an empty answer means the destination is not
 * offered at all.
 */
export function pagePublisher(ports: CanvasExportHostPorts): PagePublisherOffer | undefined {
  return ports.pagePublishing.publishers()[0];
}

export const createPageExportTarget: CanvasExportTargetFactory = (ports) => {
  // Pinned when the destination is built, so the account the card named is
  // the account the approved publish goes to even if the listing moves.
  const chosen = pagePublisher(ports);
  const current = (): PagePublisherOffer | undefined =>
    chosen === undefined
      ? undefined
      : ports.pagePublishing
          .publishers()
          .find((offer) => String(offer.instanceId) === String(chosen.instanceId));
  return {
    contribution: decodeCanvasExportContribution({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId: PAGE_EXPORT_TARGET_ID,
      label: chosen === undefined ? UNLISTED_LABEL : pageExportTargetLabel(chosen.label),
      formats: ["html"],
    }),

    describeDestination() {
      const publisher = current();
      if (publisher === undefined || publisher.availability.kind !== "ready") return undefined;
      // No path: the page has no address until it exists. No audience either:
      // the page is private, and making it public is done on the account, not
      // here. The account the page goes out under is what the person approves.
      return {
        account: publisher.availability.account,
        note: pageExportNote(publisher.label),
      };
    },

    async exportDocument(output) {
      const publisher = current();
      if (publisher === undefined) return refused("not-connected", NO_PUBLISHER);
      const availability = publisher.availability;
      if (availability.kind === "not-signed-in") return refused("not-connected", NOT_SIGNED_IN);
      if (availability.kind === "refused") return refused("refused", availability.reason);
      if (output.format !== "html") {
        return refused("unsupported-format", "A shared page is HTML only.");
      }
      if (!isCanvasShareSafeText(output.body)) {
        return refused("refused", "The document contains text that cannot leave this Mac.");
      }
      const outcome = await ports.pagePublishing.publish(publisher.instanceId, {
        fileName: canvasExportPlannedName(output.title, "html"),
        title: output.title,
        html: output.body,
      });
      if (outcome.kind === "not-signed-in") return refused("not-connected", NOT_SIGNED_IN);
      if (outcome.kind === "refused") return refused("refused", outcome.message);
      if (outcome.kind === "unavailable") return refused("unavailable", outcome.message);
      return decodeCanvasExportDelivery({
        kind: "receipt",
        receipt: decodeCanvasExportReceipt({ kind: "link", href: outcome.address }),
      });
    },
  };
};
