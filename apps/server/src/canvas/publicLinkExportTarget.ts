import {
  CANVAS_EXPORT_LINK_DEFAULT_EXPIRY_DAYS,
  decodeCanvasExportContribution,
  decodeCanvasExportDelivery,
  decodeCanvasExportReceipt,
  type CanvasExportDelivery,
  type CanvasExportRefusal,
} from "@octant/contracts/canvas-export";
import { decodeCanvasPublicShareDocument } from "@octant/contracts/canvas-public-share";
import type { CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import type { CanvasExportActivationFacts } from "@octant/plugin-host/canvas-export-contributions";
import type { CanvasPublicShareService } from "./canvasPublicShareService";

/**
 * Publishing a Canvas as a public link.
 *
 * This rides the same published export port a third-party destination does:
 * it declares a contribution, describes what the person approves (the service
 * it goes to, that anyone with the link can open it, that the service can read
 * it, its expiry, and the link an update replaces), and is called only after
 * that approval. It is offered only while Settings › Data & privacy › Public
 * links is on, so a host with the switch off never lists it and never sends anything.
 *
 * The payload is the share document the export service rendered and the card
 * showed; this decodes it again and sends exactly that.
 */

export const PUBLIC_LINK_EXPORT_TARGET_ID = "public-link";
export const PUBLIC_LINK_EXPORT_TARGET_LABEL = "Public link";

function refused(code: CanvasExportRefusal["code"], message: string): CanvasExportDelivery {
  return { kind: "refused", code, message };
}

/** The note the card shows, so who can read the link is said before it exists. */
export function publicLinkNote(serviceHost: string): string {
  return `Anyone with the link can open it. ${serviceHost} stores this Canvas, can read it, and shows its title and summary in link previews.`;
}

/**
 * The destination's activation facts. It is offered only when Public links is
 * on; a host with no credential store to keep the owner secret in is a
 * standing refusal rather than a link it could never revoke.
 */
export function publicLinkActivationFacts(
  links: Pick<CanvasPublicShareService, "holdsSecrets">,
): CanvasExportActivationFacts {
  const facts: CanvasExportActivationFacts = {
    installed: true,
    trusted: true,
    desiredEnabled: true,
    effectiveState: { kind: "effective" },
    connected: true,
  };
  return links.holdsSecrets()
    ? facts
    : {
        ...facts,
        standingRefusal: "This Mac has no credential store to keep a link's owner secret in.",
      };
}

export function createPublicLinkExportTarget(
  links: Pick<CanvasPublicShareService, "settings" | "activeFor" | "publish">,
): CanvasExportTarget {
  return {
    contribution: decodeCanvasExportContribution({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId: PUBLIC_LINK_EXPORT_TARGET_ID,
      label: PUBLIC_LINK_EXPORT_TARGET_LABEL,
      formats: ["share-document"],
    }),

    describeDestination(output) {
      const settings = links.settings();
      if (!settings.enabled) return undefined;
      const serviceHost = new URL(settings.serviceUrl).host;
      const active = links.activeFor(output.metadata.canvasId);
      return {
        account: serviceHost,
        // Unlisted: no index or profile shows it, but anyone holding the URL
        // opens it. The note says so in words.
        visibility: "secret",
        note: publicLinkNote(serviceHost),
        linkTerms: {
          defaultExpiryDays: CANVAS_EXPORT_LINK_DEFAULT_EXPIRY_DAYS,
          allowsPassword: true,
          ...(active === undefined
            ? {}
            : { updatesLink: active.url, hasPassword: active.passwordProtected }),
        },
      };
    },

    async exportDocument(output, confirmed) {
      if (output.format !== "share-document") {
        return refused("unsupported-format", "A public link carries the Canvas's share document.");
      }
      if (confirmed?.link === undefined) {
        return refused("approval-required", "A public link needs the terms approved on its card.");
      }
      let document;
      try {
        document = decodeCanvasPublicShareDocument(JSON.parse(output.body));
      } catch {
        return refused("malformed", "The approved document is not a public share document.");
      }
      const outcome = await links.publish({
        canvasId: output.metadata.canvasId,
        versionId: output.metadata.versionId,
        sequence: output.metadata.sequence,
        document,
        choice: confirmed.link,
      });
      if (outcome.kind === "refused") return refused(outcome.code, outcome.message);
      return decodeCanvasExportDelivery({
        kind: "receipt",
        receipt: decodeCanvasExportReceipt({
          kind: "link",
          href: outcome.record.url,
          remoteId: String(outcome.record.publicShareId),
        }),
      });
    },
  };
}
