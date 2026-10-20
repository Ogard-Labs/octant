import {
  decodeCanvasExportContribution,
  decodeCanvasExportDelivery,
  decodeCanvasExportReceipt,
  type CanvasExportDelivery,
  type CanvasExportRefusal,
} from "@octant/contracts/canvas-export";
import { isCanvasShareSafeText } from "@octant/contracts/canvas-share";
import { canvasExportPlannedName } from "@octant/domain";
import type { CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import type { ClaudePagePublisher } from "../providers/claudePagePublisher";

/**
 * Sharing a rendered Canvas as a private page on the person's Anthropic account.
 *
 * This rides the same published export port the folder and gist destinations
 * do: it declares a contribution, describes what the person is approving, and
 * is called only after approval. The page is published by the Claude runtime
 * Octant already manages, signed in as the person's existing Claude account,
 * through the publisher port — this target never sees a tool name, a prompt,
 * or a credential. A host with no signed-in Claude account offers it as
 * `not-connected`; an account that cannot publish is `refused` with the reason.
 *
 * HTML only: the page is the rendered document as the person saw it on the
 * card. The rendered HTML passes the same path-and-secret filter every
 * external export does, so a document that still carries one is refused rather
 * than published. Each share makes a new page: a one-shot session cannot
 * update a page it never opened, and the card says so.
 */

export const CLAUDE_PAGE_EXPORT_TARGET_ID = "claude-page";
export const CLAUDE_PAGE_EXPORT_TARGET_LABEL = "Share to Claude";

/** The note the card shows, so the person knows who can open the page and that a share never replaces one. */
export const CLAUDE_PAGE_NOTE =
  "Publishes the HTML as a private page on your Anthropic account. Only you can open it until you share it there. Each share makes a new page.";

const NOT_SET_UP = "Claude is not set up on this host.";
const NOT_SIGNED_IN = "Claude is not signed in.";

function refused(code: CanvasExportRefusal["code"], message: string): CanvasExportDelivery {
  return { kind: "refused", code, message };
}

export function createClaudePageExportTarget(publisher: ClaudePagePublisher): CanvasExportTarget {
  return {
    contribution: decodeCanvasExportContribution({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId: CLAUDE_PAGE_EXPORT_TARGET_ID,
      label: CLAUDE_PAGE_EXPORT_TARGET_LABEL,
      formats: ["html"],
    }),

    describeDestination() {
      const availability = publisher.availability();
      if (availability.kind !== "ready") return undefined;
      // No path: the page has no address until it exists. No audience either:
      // the page is private, and making it public is done on the account, not
      // here. The account the page goes out under is what the person approves.
      return { account: availability.account, note: CLAUDE_PAGE_NOTE };
    },

    async exportDocument(output) {
      const availability = publisher.availability();
      if (availability.kind === "absent") return refused("not-connected", NOT_SET_UP);
      if (availability.kind === "not-signed-in") return refused("not-connected", NOT_SIGNED_IN);
      if (availability.kind === "refused") return refused("refused", availability.reason);
      if (output.format !== "html") {
        return refused("unsupported-format", "A page shared to Claude is HTML only.");
      }
      if (!isCanvasShareSafeText(output.body)) {
        return refused("refused", "The document contains text that cannot leave this Mac.");
      }
      const outcome = await publisher.publish({
        fileName: canvasExportPlannedName(output.title, "html"),
        title: output.title,
        html: output.body,
      });
      if (outcome.kind === "not-signed-in") return refused("not-connected", NOT_SIGNED_IN);
      if (outcome.kind === "refused") return refused("refused", outcome.message);
      if (outcome.kind === "unavailable") return refused("unavailable", outcome.message);
      return decodeCanvasExportDelivery({
        kind: "receipt",
        receipt: decodeCanvasExportReceipt({ kind: "link", href: outcome.url }),
      });
    },
  };
}
