import { describe, expect, it } from "vitest";
import {
  avatarInitials,
  canImportGravatar,
  gravatarImageUrl,
  isProfileConfigured,
  normalizeGravatarEmail,
} from "./userProfilePolicy";

describe("avatar initials", () => {
  it("takes the first and last word, and says nothing when there is no name", () => {
    expect(avatarInitials("Ada Lovelace")).toBe("AL");
    expect(avatarInitials("Ada")).toBe("A");
    expect(avatarInitials("Ada King Lovelace")).toBe("AL");
    expect(avatarInitials("  ada   lovelace  ")).toBe("AL");

    // An empty result is a real answer: the surface draws a neutral glyph
    // rather than a letter the user never gave.
    expect(avatarInitials(undefined)).toBe("");
    expect(avatarInitials("   ")).toBe("");
  });

  it("keeps the first character of names outside the Latin alphabet", () => {
    expect(avatarInitials("良子 田中")).toBe("良田");
    expect(avatarInitials("Ада Лавлейс")).toBe("АЛ");
  });
});

describe("gravatar lookup", () => {
  it("normalises the address the way Gravatar matches it", () => {
    expect(normalizeGravatarEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("asks for a miss rather than an invented picture", () => {
    const url = gravatarImageUrl("abc123", 256);

    // Without `d=404` Gravatar answers with a generated placeholder, and
    // Octant would store an invented picture while saying it found theirs.
    expect(url).toBe("https://gravatar.com/avatar/abc123?s=256&d=404");
  });

  it("offers the lookup only once an address has actually been entered", () => {
    expect(canImportGravatar({})).toBe(false);
    expect(canImportGravatar({ email: "ada@example.com" })).toBe(true);
  });
});

describe("profile completeness", () => {
  it("reports what the user gave, and treats the untouched profile as unanswered", () => {
    expect(isProfileConfigured({ accent: "indigo", avatar: { kind: "initials" } })).toBe(false);
    expect(
      isProfileConfigured({
        displayName: "Ada Lovelace",
        accent: "indigo",
        avatar: { kind: "initials" },
      }),
    ).toBe(true);
    expect(
      isProfileConfigured({
        accent: "indigo",
        avatar: { kind: "image", source: "upload", dataUrl: "data:image/png;base64,AA==" },
      }),
    ).toBe(true);
  });
});
