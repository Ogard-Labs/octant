import { join } from "node:path";
import {
  decodeCanvasExportContribution,
  decodeCanvasExportDelivery,
  decodeCanvasExportReceipt,
  type CanvasExportDelivery,
  type CanvasExportRefusal,
  type CanvasExportRenderedOutput,
} from "@octant/contracts/canvas-export";
import { canvasExportPlannedName, freeCanvasExportFileName } from "@octant/domain";
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
 *
 * A picture export is a set of files. The card names the first and lists the
 * rest, and approving a card that said one was already there confirms the
 * whole set: each file is written at its own name, so a deck exported again
 * replaces its slides in place. Without that confirmation every file that is
 * already there gets a numbered copy beside it, as a single file would.
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
      formats: ["markdown", "html", "png", "pdf"],
    }),

    describeDestination(output) {
      const availability = dependencies.availability();
      if (availability.kind !== "ready") return undefined;
      // The names this document wants, not the next free ones: naming the file
      // that is already there is what puts the replacement in front of the
      // person instead of quietly writing a copy they never asked about.
      const files = plannedFiles(output);
      return {
        path: join(availability.folder, files[0].name),
        replacesExisting: files.some((file) =>
          dependencies.files.existsIn(availability.folder, file.name),
        ),
      };
    },

    async exportDocument(output, confirmed) {
      const availability = dependencies.availability();
      if (availability.kind === "not-chosen") {
        return refused("not-connected", "No export folder has been chosen yet.");
      }
      if (availability.kind === "refused") return refused("refused", availability.reason);
      const files = plannedFiles(output);
      const plannedPath = join(availability.folder, files[0].name);
      // The person approved the place the card named. A confirmed destination
      // that points somewhere else means the folder changed while the card was
      // open, so this delivery is refused rather than written to a folder the
      // person never approved.
      if (confirmed?.path !== undefined && confirmed.path !== plannedPath) {
        return refused("refused", "The export folder changed after this export was approved.");
      }
      // Only a card that said a file was already there counts as confirmed:
      // the person approved a replacement, not just a path. A file that
      // appeared at the name after the card was built was never named to the
      // person, so it gets the numbered copy instead. A call with no
      // confirmation — a destination reached outside a card — writes a
      // numbered copy beside an existing file too.
      const replacesConfirmed =
        confirmed?.path === plannedPath && confirmed.replacesExisting === true;
      const placed: Array<{ readonly fileName: string; readonly contents: string | Uint8Array }> =
        [];
      for (const file of files) {
        const fileName = freeCanvasExportFileName(
          file.name,
          (candidate) =>
            dependencies.files.existsIn(availability.folder, candidate) ||
            placed.some((entry) => entry.fileName === candidate),
          replacesConfirmed,
        );
        if (fileName === undefined) {
          return refused("refused", "There is no free name to write this export to.");
        }
        placed.push({ fileName, contents: file.contents });
      }
      // Each file lands whole or not at all; a set that fails part-way leaves
      // the files already written, and the refusal says the write failed.
      for (const entry of placed) {
        try {
          await dependencies.files.writeAtomically(
            availability.folder,
            entry.fileName,
            entry.contents,
            dependencies.newTempId(),
          );
        } catch {
          return refused("refused", "The export could not be written to that folder.");
        }
      }
      const first = placed[0];
      if (first === undefined) {
        return refused("refused", "There is nothing to write for this export.");
      }
      return decodeCanvasExportDelivery({
        kind: "receipt",
        receipt: decodeCanvasExportReceipt({
          kind: "path",
          path: join(availability.folder, first.fileName),
        }),
      });
    },
  };
}

/** The files one rendered output wants to be, named by policy, in writing order. */
function plannedFiles(
  output: CanvasExportRenderedOutput,
): readonly [
  { readonly name: string; readonly contents: string | Uint8Array },
  ...Array<{ readonly name: string; readonly contents: string | Uint8Array }>,
] {
  if ("body" in output) {
    return [{ name: canvasExportPlannedName(output.title, output.format), contents: output.body }];
  }
  const [first, ...rest] = output.files;
  return [
    { name: first.name, contents: first.bytes },
    ...rest.map((file) => ({ name: file.name, contents: file.bytes })),
  ];
}
