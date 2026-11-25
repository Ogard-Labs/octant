import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("mobile privacy and delivery wiring", () => {
  it("keeps host repository roots off the screenshot-safe home surface", () => {
    for (const file of ["HomeScreen.tsx", "ThreadsScreen.tsx", "NewThreadContext.tsx"]) {
      const source = readFileSync(resolve(root, "inbox", file), "utf8");
      expect(source).not.toContain("rootCandidate");
      expect(source).not.toContain("projectRoot");
    }
  });

  it("scrubs host project labels and validates Code delivery fields before decode", () => {
    const newThread = readFileSync(resolve(root, "inbox", "NewThreadContext.tsx"), "utf8");
    const threads = readFileSync(resolve(root, "inbox", "ThreadsScreen.tsx"), "utf8");
    const threadRow = readFileSync(resolve(root, "inbox", "ThreadRow.tsx"), "utf8");
    const deliverySheet = readFileSync(
      resolve(root, "inbox", "CodeDeliveryTargetSheet.tsx"),
      "utf8",
    );
    expect(newThread).toContain("formatScreenshotSafeLabel(project.name)");
    expect(threads).toContain("formatScreenshotSafeLabel(entry.name)");
    expect(threadRow).toContain("formatScreenshotSafeLabel(project)");
    expect(threadRow).toContain("formatScreenshotSafeLabel(row.title)");
    expect(deliverySheet).toContain("validateCodeDeliveryTargetFields");
    expect(deliverySheet).toContain('testID="mobile-code-delivery-error"');
  });
});
