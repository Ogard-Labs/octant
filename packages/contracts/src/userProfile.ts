import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * How the person using this host wants to be shown and addressed.
 *
 * Every field is optional and locally owned. Octant has no account, so a
 * profile authenticates nothing, authorizes nothing, and is never sent
 * anywhere: it exists so threads, commits, and shared surfaces can name a
 * human instead of a placeholder. An empty profile is a valid profile.
 */
/**
 * Upper bounds on the two typed fields, in characters.
 *
 * Exported because an editor that lets a longer value be typed and then refuses
 * it at save time reports the refusal too late to act on. The schema below is
 * still the authority; these let a surface say the same thing in place.
 */
export const MAX_USER_DISPLAY_NAME_CHARACTERS = 64;
export const MAX_USER_EMAIL_CHARACTERS = 254;

export const UserDisplayName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_USER_DISPLAY_NAME_CHARACTERS),
);
export type UserDisplayName = typeof UserDisplayName.Type;

/**
 * A syntactically plausible address, not a verified one.
 *
 * The pattern rejects obvious nonsense so a typo does not silently become a
 * Gravatar lookup for an address that cannot exist. It deliberately does not
 * try to be RFC 5322: the host cannot confirm an address either way, and a
 * stricter grammar would reject deliverable addresses while still proving
 * nothing about this one.
 */
export const UserEmailAddress = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_USER_EMAIL_CHARACTERS),
  Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);
export type UserEmailAddress = typeof UserEmailAddress.Type;

/**
 * Named accent for the initials avatar.
 *
 * A name rather than a hex colour, so the theme owns the rendered value and a
 * profile picked in one theme stays legible in another.
 */
export const AvatarAccent = Schema.Literal(
  "slate",
  "indigo",
  "violet",
  "teal",
  "green",
  "amber",
  "rose",
  "cyan",
);
export type AvatarAccent = typeof AvatarAccent.Type;

export const AVATAR_ACCENTS: ReadonlyArray<AvatarAccent> = [
  "slate",
  "indigo",
  "violet",
  "teal",
  "green",
  "amber",
  "rose",
  "cyan",
];

export const DEFAULT_AVATAR_ACCENT: AvatarAccent = "indigo";

/**
 * Upper bound on a stored avatar, in encoded characters (~96 KB).
 *
 * Avatars ride in journaled shell settings, so an unbounded image would grow
 * every replay of this host's settings forever. The renderer downscales before
 * encoding; this bound is the contract's own refusal, not a reminder to it.
 */
export const MAX_AVATAR_IMAGE_CHARACTERS = 96 * 1024;

export const AvatarImageDataUrl = Schema.NonEmptyString.pipe(
  Schema.maxLength(MAX_AVATAR_IMAGE_CHARACTERS),
  Schema.pattern(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
);
export type AvatarImageDataUrl = typeof AvatarImageDataUrl.Type;

/**
 * Where an image avatar came from.
 *
 * Recorded because the two origins are different facts about the same picture:
 * an upload never left this Mac, while a Gravatar import was fetched once from
 * gravatar.com at the user's explicit request. The surface says which, so the
 * user can see that an external service was contacted.
 */
export const AvatarImageSource = Schema.Literal("upload", "gravatar");
export type AvatarImageSource = typeof AvatarImageSource.Type;

const InitialsAvatar = Schema.Struct({
  kind: Schema.Literal("initials"),
}).annotations(strict);

const ImageAvatar = Schema.Struct({
  kind: Schema.Literal("image"),
  source: AvatarImageSource,
  /**
   * The picture itself, inlined. A Gravatar import is copied here at import
   * time rather than referenced by URL, so the avatar renders offline and the
   * host never contacts gravatar.com again on its own.
   */
  dataUrl: AvatarImageDataUrl,
}).annotations(strict);

export const UserAvatar = Schema.Union(InitialsAvatar, ImageAvatar).annotations(strict);
export type UserAvatar = typeof UserAvatar.Type;

export const DEFAULT_USER_AVATAR: UserAvatar = { kind: "initials" };

/**
 * The host-owned profile section of shell settings.
 *
 * A store persisted before profiles shipped decodes to the empty profile: no
 * name, no address, initials avatar on the default accent. That is the honest
 * reading of a store that was never asked — not a reason to invent a name from
 * the OS account.
 */
export const UserProfile = Schema.Struct({
  displayName: Schema.optional(UserDisplayName),
  email: Schema.optional(UserEmailAddress),
  accent: Schema.optionalWith(AvatarAccent, { default: () => DEFAULT_AVATAR_ACCENT }),
  avatar: Schema.optionalWith(UserAvatar, { default: () => DEFAULT_USER_AVATAR }),
}).annotations(strict);
export type UserProfile = typeof UserProfile.Type;

export const decodeUserProfile = Schema.decodeUnknownSync(UserProfile);
export const decodeAvatarImageDataUrl = Schema.decodeUnknownSync(AvatarImageDataUrl);
export const decodeUserEmailAddress = Schema.decodeUnknownSync(UserEmailAddress);
