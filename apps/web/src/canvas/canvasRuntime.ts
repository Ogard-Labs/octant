import type { CanvasDefinition } from "@octant/contracts/canvas";
import { CanvasPolicyRejected, validateCanvasDefinition } from "@octant/domain/canvas-policy";

export type CanvasRenderGate =
  | { readonly ok: true; readonly definition: CanvasDefinition }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Fail-closed gate before any Canvas block is mounted. The same server-side
 * policy that guards persistence also guards the shared renderer, so hostile
 * or unsupported definitions never reach block components.
 */
export function decodeCanvasForRender(input: unknown): CanvasRenderGate {
  try {
    return { ok: true, definition: validateCanvasDefinition(input) };
  } catch (error) {
    if (error instanceof CanvasPolicyRejected) {
      return { ok: false, code: error.code, message: error.message };
    }
    return {
      ok: false,
      code: "invalid-schema",
      message: "Canvas definition could not be validated.",
    };
  }
}

/**
 * A link is only rendered as an anchor when it is a credential-free http(s)
 * URL. Anything else (javascript:, data:, file:, relative or opaque values)
 * fails closed to inert plain text.
 */
export function isSafeLinkHref(href: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/** Renders a validated scalar the same way across every block kind. */
export function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && !Number.isFinite(value)) return "—";
  return String(value);
}
