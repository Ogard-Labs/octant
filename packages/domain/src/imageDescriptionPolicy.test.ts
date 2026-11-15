import { describe, expect, it } from "vitest";
import { MAX_IMAGE_DESCRIPTION_CHARACTERS } from "@octant/contracts";
import {
  boundImageDescription,
  describedImageText,
  imageReadingRefusal,
} from "./imageDescriptionPolicy";

describe("image descriptions for a model that cannot see", () => {
  it("names the image and the model that described it", () => {
    expect(
      describedImageText({
        name: "login.png",
        describedBy: { model: "Haiku 5.5", provider: "Anthropic" },
        description: "  A sign-in form with an error under the password field.  ",
      }),
    ).toBe(
      "[Image login.png, described by Haiku 5.5 (Anthropic)]: A sign-in form with an error under the password field.",
    );
  });

  it("cuts a long description to the bound and says it was cut", () => {
    const bounded = boundImageDescription("x".repeat(MAX_IMAGE_DESCRIPTION_CHARACTERS * 2));
    expect(bounded.length).toBe(MAX_IMAGE_DESCRIPTION_CHARACTERS);
    expect(bounded.endsWith("[description cut short]")).toBe(true);
  });

  it("gives the plain fix when Sees images has no model, and each skipped model's reason otherwise", () => {
    expect(imageReadingRefusal({ model: "Luna", skipped: [] })).toBe(
      "Luna can't read images. Set a model that sees images in Model roles.",
    );
    const refusal = imageReadingRefusal({
      model: "Luna",
      skipped: [{ model: "Haiku 5.5", provider: "Anthropic", reason: "project-incompatible" }],
    });
    expect(refusal).toContain("Haiku 5.5 (Anthropic)");
    expect(refusal).toContain("not allowed by this Project's provider policy or data rules");
  });
});
