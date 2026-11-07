import {
  decodeCanvasExportContribution,
  decodeCanvasExportDelivery,
  decodeCanvasExportReceipt,
  type CanvasExportDelivery,
} from "@octant/contracts/canvas-export";
import { isCanvasShareSafeText } from "@octant/contracts/canvas-share";
import type { CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import type { SharehtmlPort } from "./sharehtmlPort";

/**
 * Publishing a rendered Canvas as one HTML page on sharehtml.org.
 *
 * This rides the same published export port a third-party destination does: it
 * declares a contribution, describes what the person is approving, and is
 * called only after approval. The service needs no account for an anonymous
 * upload; the page is always unlisted, served byte-for-byte on its own origin,
 * kept until deleted, and capped at 5 MB free. The manage URL comes back once
 * and is shown in the receipt — losing it means the page can only be deleted
 * from a signed-in sharehtml.org session.
 *
 * The target re-checks the whole rendered page with the share filter, the same
 * one every exported document passes: a payload that still carries a path or a
 * secret-shaped value is refused rather than published.
 */

export const SHAREHTML_EXPORT_TARGET_ID = "sharehtml";
export const SHAREHTML_EXPORT_TARGET_LABEL = "sharehtml.org";

/** The note the card shows so the unlisted, kept-forever choice is made knowingly. */
export const SHAREHTML_DESTINATION_NOTE =
  "Unlisted: anyone with the link can open the page, and sharehtml.org serves it as written on its own origin. Free pages are kept until deleted and capped at 5 MB.";

export interface SharehtmlExportTargetDependencies {
  readonly pages: SharehtmlPort;
}

function refused(
  code: "refused" | "unsupported-format" | "unavailable",
  message: string,
): CanvasExportDelivery {
  return { kind: "refused", code, message };
}

export function createSharehtmlExportTarget(
  dependencies: SharehtmlExportTargetDependencies,
): CanvasExportTarget {
  return {
    contribution: decodeCanvasExportContribution({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId: SHAREHTML_EXPORT_TARGET_ID,
      label: SHAREHTML_EXPORT_TARGET_LABEL,
      formats: ["html"],
    }),

    describeDestination() {
      // No account and no audience choice: anonymous creation is always
      // unlisted. The note is what the person approves.
      return { note: SHAREHTML_DESTINATION_NOTE };
    },

    async exportDocument(output) {
      if (output.format !== "html") {
        return refused("unsupported-format", "sharehtml.org takes one rendered HTML page.");
      }
      if (!isCanvasShareSafeText(output.body)) {
        return refused("refused", "The document contains text that cannot leave this computer.");
      }
      // The host's own export body budget (256 KiB) sits far below the
      // service's 5 MB free cap, so an oversize page is refused by the port.
      const outcome = await dependencies.pages.createPage(output.body);
      if (outcome.kind === "refused") return refused("refused", outcome.message);
      if (outcome.kind === "unavailable") return refused("unavailable", outcome.message);
      return decodeCanvasExportDelivery({
        kind: "receipt",
        receipt: decodeCanvasExportReceipt({
          kind: "link",
          href: outcome.url,
          remoteId: outcome.id,
        }),
      });
    },
  };
}
