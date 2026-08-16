import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("mobile privacy and delivery wiring", () => {
  it("keeps host repository roots off the screenshot-safe home surface", () => {
    const home = readFileSync(resolve(root, "inbox", "InboxHomeScreen.tsx"), "utf8");
    expect(home).not.toContain("rootCandidate");
    expect(home).not.toContain("projectRoot");
  });

  it("scrubs host project labels and validates Code delivery fields before decode", () => {
    const home = readFileSync(resolve(root, "inbox", "InboxHomeScreen.tsx"), "utf8");
    const deliverySheet = readFileSync(
      resolve(root, "inbox", "CodeDeliveryTargetSheet.tsx"),
      "utf8",
    );
    expect(home).toContain("formatScreenshotSafeLabel(project.name)");
    expect(deliverySheet).toContain("validateCodeDeliveryTargetFields");
    expect(deliverySheet).toContain('testID="mobile-code-delivery-error"');
  });
});
