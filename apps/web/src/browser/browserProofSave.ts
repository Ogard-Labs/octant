import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserCapture, BrowserThreadId } from "@octant/contracts";
import { browserProofCaptureOrder } from "@octant/domain";
import type { BrowserProofSaveResult, OctantHostBridge } from "../shell/hostBridge";

/**
 * Whether this window can save the proof's pictures to a folder. Only the
 * desktop app's own window can: a browser or a paired device has no native
 * folder picker and writes nothing to this computer.
 */
export function canSaveBrowserProofScreenshots(bridge: OctantHostBridge | undefined): boolean {
  return bridge?.saveBrowserProofScreenshots !== undefined;
}

/**
 * Read each kept picture and hand them to the desktop app, which asks the
 * person for a folder and writes them as numbered files. The files are
 * numbered oldest first, the numbers the pull request section names.
 */
export async function saveBrowserProofScreenshots(input: {
  readonly client: BrowserAutomationClient;
  readonly threadId: BrowserThreadId;
  readonly captures: ReadonlyArray<BrowserCapture>;
  readonly bridge: OctantHostBridge | undefined;
}): Promise<BrowserProofSaveResult> {
  const save = input.bridge?.saveBrowserProofScreenshots;
  const read = input.client.readCapture;
  if (save === undefined || read === undefined) {
    throw new Error("Screenshots can be saved only from the Octant app on this computer.");
  }
  const pictures = await Promise.all(
    browserProofCaptureOrder(input.captures).map(async (capture, index) => ({
      fileNumber: index + 1,
      dataUrl: (
        await read.call(input.client, { threadId: input.threadId, captureId: capture.captureId })
      ).dataUrl,
    })),
  );
  return await save.call(input.bridge, pictures);
}

/**
 * The save control's words. A recording is saved with the screenshots (an
 * animated PNG keeps `.png`), so the control names both once there is one.
 */
export function browserProofSaveLabel(captures: ReadonlyArray<BrowserCapture>): string {
  return captures.some((capture) => capture.recording !== undefined)
    ? "Save screenshots and recordings…"
    : "Save screenshots…";
}

/** One sentence for the result of a save, or nothing when the person cancelled. */
export function browserProofSaveMessage(
  result: BrowserProofSaveResult,
  captures: ReadonlyArray<BrowserCapture> = [],
): string | undefined {
  if (result.kind === "cancelled") return undefined;
  const noun = captures.some((capture) => capture.recording !== undefined)
    ? result.count === 1
      ? "file"
      : "files"
    : result.count === 1
      ? "screenshot"
      : "screenshots";
  return `Saved ${result.count} ${noun} to “${result.folderName}”.`;
}
