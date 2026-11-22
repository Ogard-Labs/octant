import type { CanvasShareImage } from "./shareKit.ts";

/**
 * One carried image's response, once its route has checked the reader may
 * see it. The bytes at an address never change, so the digest is the ETag;
 * `no-cache` makes the browser ask again before each reuse, so a revoked or
 * expired link, a lapsed password grant or an expired token stops serving a
 * copy the browser kept. A page that shows one image many times still loads
 * it once.
 */
export function carriedImageResponse(
  request: Request,
  image: CanvasShareImage,
  headers: Readonly<Record<string, string>>,
): Response {
  const tag = `"${image.sha256}"`;
  // The route's own content type is for its refusals; a 304 carries none, so
  // a cache keeps the raster's type.
  const { "content-type": _refusalType, ...rest } = headers;
  const common = { ...rest, etag: tag, "cache-control": "private, no-cache" };
  if (request.headers.get("if-none-match") === tag) {
    return new Response(null, { status: 304, headers: common });
  }
  return new Response(Buffer.from(image.data ?? "", "base64"), {
    status: 200,
    headers: { ...common, "content-type": image.mediaType },
  });
}
