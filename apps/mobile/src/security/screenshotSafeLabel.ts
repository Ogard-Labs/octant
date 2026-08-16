import { scrubScreenshotSafeCopy } from "@octant/domain";

/** Display labels safe for recents / screenshots (no secrets or absolute paths). */
export function formatScreenshotSafeLabel(value: string, maxLength = 120): string {
  return scrubScreenshotSafeCopy(value, maxLength);
}
