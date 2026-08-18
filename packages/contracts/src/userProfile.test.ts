import { describe, expect, it } from "vitest";
import {
  MAX_AVATAR_IMAGE_CHARACTERS,
  decodeAvatarImageDataUrl,
  decodeUserEmailAddress,
  decodeUserProfile,
} from "./userProfile";

const pngPixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("user profile contract", () => {
  it("treats an unanswered profile as empty rather than guessing one", () => {
    const decoded = decodeUserProfile({});

    expect(decoded.displayName).toBeUndefined();
    expect(decoded.email).toBeUndefined();
    expect(decoded.accent).toBe("indigo");
    expect(decoded.avatar).toEqual({ kind: "initials" });
  });

  it("keeps a fully answered profile intact", () => {
    expect(
      decodeUserProfile({
        displayName: "Ada Lovelace",
        email: "ada@example.com",
        accent: "rose",
        avatar: { kind: "image", source: "gravatar", dataUrl: pngPixel },
      }),
    ).toEqual({
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      accent: "rose",
      avatar: { kind: "image", source: "gravatar", dataUrl: pngPixel },
    });
  });

  it("rejects an address it could not plausibly hash or display", () => {
    expect(decodeUserEmailAddress("ada@example.com")).toBe("ada@example.com");
    expect(() => decodeUserEmailAddress("ada@example")).toThrow();
    expect(() => decodeUserEmailAddress("ada example.com")).toThrow();
    expect(() => decodeUserEmailAddress("")).toThrow();
  });

  it("accepts only an inlined image small enough to live in journaled settings", () => {
    expect(decodeAvatarImageDataUrl(pngPixel)).toBe(pngPixel);

    // A remote reference would make the avatar depend on a network the host
    // may not have, and would keep contacting whoever serves it.
    expect(() => decodeAvatarImageDataUrl("https://gravatar.com/avatar/abc")).toThrow();
    expect(() => decodeAvatarImageDataUrl("data:text/html;base64,PGI+")).toThrow();
    expect(() =>
      decodeAvatarImageDataUrl(`data:image/png;base64,${"A".repeat(MAX_AVATAR_IMAGE_CHARACTERS)}`),
    ).toThrow();
  });

  it("refuses an avatar whose origin is not recorded", () => {
    // The two origins are different facts: an upload never left this Mac, a
    // Gravatar import was fetched once from gravatar.com. A picture that
    // cannot say which is a picture the surface cannot describe honestly.
    expect(() => decodeUserProfile({ avatar: { kind: "image", dataUrl: pngPixel } })).toThrow();
    expect(() =>
      decodeUserProfile({ avatar: { kind: "image", source: "imported", dataUrl: pngPixel } }),
    ).toThrow();
  });
});
