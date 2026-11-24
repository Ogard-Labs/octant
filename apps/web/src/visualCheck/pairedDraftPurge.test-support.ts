import assert from "node:assert/strict";
import type { Page } from "playwright-core";

export async function verifyPairedDraftPurge(page: Page): Promise<void> {
  await page.addScriptTag({
    type: "module",
    url: "/src/visualCheck/pairedDraftPurge.browser.ts",
  });
  const result = await page.evaluate(() => window.octantPairedDraftPurge);
  assert.deepEqual(result, {
    whileUnavailable: ["Archived", "Purged draft", "Work with the same ID"],
    recoveryWhileUnavailable: "Purged recovery",
    paired: ["Archived", "Work with the same ID"],
    other: ["Other computer"],
    recoveryAfter: undefined,
  });
}
