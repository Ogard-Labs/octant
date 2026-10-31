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
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateExtensionPopupRequest(value: unknown): ExtensionPopupRequest {
  if (typeof value !== "object" || value === null) throw invalid();
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (keys.some((key) => !["profile", "extensionId", "kind", "bounds"].includes(key))) {
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
  const bounds = request.bounds as Record<string, unknown> | undefined;
  if (typeof bounds !== "object" || bounds === null) throw invalid();
  const numbers: number[] = [];
  for (const key of ["x", "y", "width", "height"]) {
    const number = bounds[key];
    if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 20_000) {
      throw invalid();
    }
    numbers.push(number);
  }
  const [x = 0, y = 0, width = 0, height = 0] = numbers;
  return {
    profile: checked,
    extensionId: request.extensionId,
    kind: request.kind,
    bounds: { x, y, width, height },
  };
}

function invalid(): TypeError {
  return new TypeError("Octant rejected an invalid extension popup request.");
}
