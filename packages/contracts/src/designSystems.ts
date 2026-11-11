import { Schema } from "effect";
import { CanvasDesignBrand } from "./canvasBrand";

/**
 * A Project's design system is a `DESIGN.md` file in its folder: prose rules a
 * person and an agent both read, with an optional front matter of named
 * tokens (colours, type, radii, spacing). The file is the source of truth;
 * Octant reads it, draws it, and lends its tokens to Canvas as a brand, but
 * keeps no copy on the Project record.
 */
export const DESIGN_SYSTEM_FILE_NAME = "DESIGN.md";

/** Larger than this and the file is left to the person's editor. */
export const MAX_DESIGN_SYSTEM_FILE_BYTES = 262_144;
/** How many design systems one Project lists; a deeper search stops here. */
export const MAX_DESIGN_SYSTEMS_PER_PROJECT = 64;
/** How deep below a folder's root a `DESIGN.md` is looked for. */
export const MAX_DESIGN_SYSTEM_SEARCH_DEPTH = 4;

export const DesignSystemTokenGroup = Schema.Literal("color", "font", "radius", "space");
export type DesignSystemTokenGroup = typeof DesignSystemTokenGroup.Type;

/**
 * What became of one front-matter token on its way to a Canvas brand:
 * `carried` as written, `adjusted` (a font stack with the faces Canvas cannot
 * draw left out), or `refused` with the reason.
 */
export const DesignSystemTokenStatus = Schema.Literal("carried", "adjusted", "refused");
export type DesignSystemTokenStatus = typeof DesignSystemTokenStatus.Type;

export const DesignSystemToken = Schema.Struct({
  group: DesignSystemTokenGroup,
  /** The key as the file writes it, e.g. `primary` under `colors`. */
  key: Schema.String,
  /** The brand token it becomes, e.g. `color-primary`. */
  token: Schema.String,
  value: Schema.String,
  status: DesignSystemTokenStatus,
  /** The value Canvas draws with, when it differs from the file's. */
  carriedValue: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});
export type DesignSystemToken = typeof DesignSystemToken.Type;

/** `absent`: no front matter; `invalid`: front matter that is not a mapping. */
export const DesignSystemFrontMatterState = Schema.Literal("absent", "parsed", "invalid");
export type DesignSystemFrontMatterState = typeof DesignSystemFrontMatterState.Type;

export const DesignSystemReading = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  frontMatter: DesignSystemFrontMatterState,
  tokens: Schema.Array(DesignSystemToken),
  /** Every carried or adjusted token, as a design's `brand` takes it. */
  brand: CanvasDesignBrand,
  /** Front-matter keys Octant does not read, listed so nothing seems lost. */
  ignoredKeys: Schema.Array(Schema.String),
  /** The level-two headings of the prose, in order. */
  sections: Schema.Array(Schema.String),
  /** The prose after the front matter. */
  body: Schema.String,
});
export type DesignSystemReading = typeof DesignSystemReading.Type;

/** A path relative to its folder, with `/` separators and no `.` or `..` segment. */
export const DesignSystemRelativePath = Schema.String.pipe(
  Schema.filter(
    (path) =>
      path.length > 0 &&
      path.length <= 1024 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\u0000") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
      path.split("/").at(-1) === DESIGN_SYSTEM_FILE_NAME,
    { message: () => `A design system path ends in ${DESIGN_SYSTEM_FILE_NAME} inside its folder.` },
  ),
);

export const DesignSystemLocation = Schema.Struct({
  /** The Project folder it lives in: the main folder or an extra folder. */
  folder: Schema.String,
  path: DesignSystemRelativePath,
});
export type DesignSystemLocation = typeof DesignSystemLocation.Type;

/**
 * Which design system a Project follows, chosen by a person. `file` names one
 * of its `DESIGN.md` files; `none` turns design systems off for the Project.
 * Absent on the Project record means the automatic rule: the top-level file,
 * else the only one.
 */
export const DesignSystemChoice = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("file"), ...DesignSystemLocation.fields }),
  Schema.Struct({ kind: Schema.Literal("none") }),
);
export type DesignSystemChoice = typeof DesignSystemChoice.Type;

export const DesignSystemListing = Schema.Struct({
  ...DesignSystemLocation.fields,
  name: Schema.String,
  tokenCount: Schema.Int,
  /** The one Canvas draws with and every turn is given in full. */
  primary: Schema.Boolean,
});
export type DesignSystemListing = typeof DesignSystemListing.Type;

export const DesignSystemList = Schema.Struct({
  systems: Schema.Array(DesignSystemListing),
  /** The person's choice, when they made one; absent follows the automatic rule. */
  choice: Schema.optional(DesignSystemChoice),
  /** True when the chosen file is not there, so the Project follows none. */
  choiceMissing: Schema.optional(Schema.Boolean),
  /** True when the search stopped at its limit and more may exist. */
  truncated: Schema.Boolean,
});
export type DesignSystemList = typeof DesignSystemList.Type;

export const DesignSystemDocument = Schema.Struct({
  ...DesignSystemLocation.fields,
  text: Schema.String,
  /** A digest of `text`; a save must name the one it replaces. */
  revision: Schema.String,
  reading: DesignSystemReading,
});
export type DesignSystemDocument = typeof DesignSystemDocument.Type;

export const DesignSystemWriteRequest = Schema.Struct({
  projectId: Schema.String,
  ...DesignSystemLocation.fields,
  text: Schema.String.pipe(Schema.maxLength(MAX_DESIGN_SYSTEM_FILE_BYTES)),
  /** Absent creates the file and refuses if it exists; present replaces exactly that revision. */
  baseRevision: Schema.optional(Schema.String),
});
export type DesignSystemWriteRequest = typeof DesignSystemWriteRequest.Type;

export const DesignSystemWriteResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("saved"), document: DesignSystemDocument }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal(
      "exists",
      "stale",
      "missing",
      "too-large",
      "not-a-file",
      "folder-unavailable",
      "unwritable",
    ),
  }),
);
export type DesignSystemWriteResult = typeof DesignSystemWriteResult.Type;

export const decodeDesignSystemList = Schema.decodeUnknownSync(DesignSystemList);
export const decodeDesignSystemDocument = Schema.decodeUnknownSync(DesignSystemDocument);
export const decodeDesignSystemWriteRequest = Schema.decodeUnknownSync(DesignSystemWriteRequest);
export const decodeDesignSystemWriteResult = Schema.decodeUnknownSync(DesignSystemWriteResult);
