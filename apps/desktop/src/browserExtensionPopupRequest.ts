/**
 * What the renderer may ask the desktop app to show: one extension's popup or
 * options page, in a profile, anchored at a rectangle. Shared by the preload and
 * the main process so both refuse the same shapes; it imports nothing at runtime.
 */
export interface ExtensionPopupRequest {
  readonly profile:
    | { readonly kind: "personal" }
    | { readonly kind: "project"; readonly projectId: string };
  readonly extensionId: string;
  readonly kind: "popup" | "options";
  /** The extensions button's rectangle in the window; the popup sits beside it. */
  readonly anchor: PopupRect;
  /** The size the popup would like; it is shrunk to the space the window has. */
  readonly size: { readonly width: number; readonly height: number };
}

export interface PopupRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Air between the button and the popup, and the toolbar height nothing may cover. */
const POPUP_GAP = 4;
const TOP_INSET = 36;

/**
 * Where the popup goes so that it is inside the window: below the button when
 * it fits, above it when that has more room, shifted left from a right edge, and
 * shrunk to the space left. The main process validates the result as it does
 * every native surface, so a button near an edge opens a smaller popup rather
 * than none.
 */
export function fitPopupBounds(
  anchor: PopupRect,
  size: { readonly width: number; readonly height: number },
  content: { readonly width: number; readonly height: number },
): PopupRect {
  const width = Math.max(1, Math.min(size.width, content.width));
  const x = Math.max(0, Math.min(anchor.x, content.width - width));
  const below = content.height - (anchor.y + anchor.height + POPUP_GAP);
  const above = anchor.y - POPUP_GAP - TOP_INSET;
  if (below >= size.height || below >= above) {
    const height = Math.max(1, Math.min(size.height, below));
    return {
      x,
      y: Math.min(anchor.y + anchor.height + POPUP_GAP, content.height - height),
      width,
      height,
    };
  }
  const height = Math.max(1, Math.min(size.height, above));
  return { x, y: Math.max(TOP_INSET, anchor.y - POPUP_GAP - height), width, height };
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateExtensionPopupRequest(value: unknown): ExtensionPopupRequest {
  if (typeof value !== "object" || value === null) throw invalid();
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (keys.some((key) => !["profile", "extensionId", "kind", "anchor", "size"].includes(key))) {
    throw invalid();
  }
  const profile = request.profile as Record<string, unknown> | undefined;
  if (typeof profile !== "object" || profile === null) throw invalid();
  let checked: ExtensionPopupRequest["profile"];
  if (profile.kind === "personal" && Object.keys(profile).length === 1) {
    checked = { kind: "personal" };
  } else if (
    profile.kind === "project" &&
    Object.keys(profile).length === 2 &&
    typeof profile.projectId === "string" &&
    PROJECT_ID.test(profile.projectId)
  ) {
    checked = { kind: "project", projectId: profile.projectId };
  } else {
    throw invalid();
  }
  if (typeof request.extensionId !== "string" || !/^[0-9a-f]{32}$/.test(request.extensionId)) {
    throw invalid();
  }
  if (request.kind !== "popup" && request.kind !== "options") throw invalid();
  const [x = 0, y = 0, width = 0, height = 0] = numbersOf(request.anchor, [
    "x",
    "y",
    "width",
    "height",
  ]);
  const [popupWidth = 0, popupHeight = 0] = numbersOf(request.size, ["width", "height"]);
  if (popupWidth < 1 || popupHeight < 1) throw invalid();
  return {
    profile: checked,
    extensionId: request.extensionId,
    kind: request.kind,
    anchor: { x, y, width, height },
    size: { width: popupWidth, height: popupHeight },
  };
}

function numbersOf(value: unknown, keys: ReadonlyArray<string>): ReadonlyArray<number> {
  if (typeof value !== "object" || value === null) throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length) throw invalid();
  return keys.map((key) => {
    const number = record[key];
    if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 20_000) {
      throw invalid();
    }
    return number;
  });
}

function invalid(): TypeError {
  return new TypeError("Octant rejected an invalid extension popup request.");
}
