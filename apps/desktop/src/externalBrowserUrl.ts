/**
 * The one check both desktop mains run before handing a URL to the person's
 * default browser. Only plain web pages leave the app: a `file:`, `javascript:`
 * or custom-scheme URL could open a local file or another app, and embedded
 * credentials would reach that browser's history.
 */
export function validateExternalBrowserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("Octant rejected an invalid external Browser URL.");
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error("Octant rejected an invalid external Browser URL.");
  }
}
