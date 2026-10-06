import { join } from "node:path";
import {
  decodeCanvasExportContribution,
  decodeCanvasExportDelivery,
  decodeCanvasExportReceipt,
  type CanvasExportDelivery,
  type CanvasExportRefusal,
} from "@octant/contracts/canvas-export";
import { canvasExportPlannedName, planCanvasExportFileName } from "@octant/domain";
import type { CanvasExportTarget } from "@octant/plugin-api/canvas-export";
import type { CanvasExportFilePort } from "./canvasExportFilePort";

/**
 * Writing a rendered Canvas into a folder the person chose.
 *
 * This is an ordinary destination on the published seam: it declares a
 * contribution and is called only after approval, exactly as a third-party
 * plugin would be. What is specific to a folder is that its destination is
 * knowable in advance, so it names the file on the approval card — and that
 * naming is what lets approving the card replace an existing file. Invoked
 * without that confirmation it writes beside the file instead.
 */

export const FOLDER_EXPORT_TARGET_ID = "folder-on-this-mac";
export const FOLDER_EXPORT_TARGET_LABEL = "A folder on this Mac";

/** What the folder destination can do for one Canvas, read from the host. */
export type FolderExportAvailability =
  | { readonly kind: "ready"; readonly folder: string }
  | { readonly kind: "not-chosen" }
  | { readonly kind: "refused"; readonly reason: string };

export interface FolderExportTargetDependencies {
  readonly availability: () => FolderExportAvailability;
  readonly files: CanvasExportFilePort;
  readonly newTempId: () => string;
}

function refused(code: CanvasExportRefusal["code"], message: string): CanvasExportDelivery {
  return { kind: "refused", code, message };
}

export function createFolderExportTarget(
  dependencies: FolderExportTargetDependencies,
): CanvasExportTarget {
  return {
    contribution: decodeCanvasExportContribution({
      schemaVersion: 1,
      kind: "canvas-export-contribution",
      targetId: FOLDER_EXPORT_TARGET_ID,
      label: FOLDER_EXPORT_TARGET_LABEL,
      formats: ["markdown", "html"],
    }),

    describeDestination(output) {
      const availability = dependencies.availability();
      if (availability.kind !== "ready") return undefined;
      // The name this document wants, not the next free one: naming the file
      // that is already there is what puts the replacement in front of the
      // person instead of quietly writing a copy they never asked about.
      const fileName = canvasExportPlannedName(output.title, output.format);
      return {
        path: join(availability.folder, fileName),
        replacesExisting: dependencies.files.existsIn(availability.folder, fileName),
      };
    },

    async exportDocument(output, confirmed) {
      const availability = dependencies.availability();
      if (availability.kind === "not-chosen") {
        return refused("not-connected", "No export folder has been chosen yet.");
      }
      if (availability.kind === "refused") return refused("refused", availability.reason);
      const planned = canvasExportPlannedName(output.title, output.format);
      const fileName = planCanvasExportFileName({
        title: output.title,
        format: output.format,
        taken: (candidate) => dependencies.files.existsIn(availability.folder, candidate),
        // Only the path the approval card named counts as confirmed: the person
        // approved a place, so writing there replaces whatever is in it. A call
        // with no confirmation — a destination reached outside a card — writes
        // a numbered copy beside an existing file instead.
        replacesConfirmed:
          confirmed !== undefined && confirmed.path === join(availability.folder, planned),
      });
      if (fileName === undefined) {
        return refused("refused", "There is no free name to write this export to.");
      }
      try {
        await dependencies.files.writeAtomically(
          availability.folder,
          fileName,
          output.body,
          dependencies.newTempId(),
        );
      } catch {
        return refused("refused", "The export could not be written to that folder.");
      }
      return decodeCanvasExportDelivery({
        kind: "receipt",
        receipt: decodeCanvasExportReceipt({
          kind: "path",
          path: join(availability.folder, fileName),
        }),
      });
    },
  };
}
