import { THREAD_VIDEO_ARCHIVE_PATH } from "@octant/contracts/thread-export";

/** The renderer may supply a ticket only. The owned window determines the host. */
export function startThreadVideoArchiveDownload(
  contents: { readonly downloadURL: (url: string) => void },
  host: string | undefined,
  ticket: unknown,
): boolean {
  if (host === undefined || typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket))
    return false;
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return false;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  )
    return false;
  const request = new URL(THREAD_VIDEO_ARCHIVE_PATH, url.origin);
  request.searchParams.set("ticket", ticket);
  // Electron starts an attachment download without navigating the renderer.
  contents.downloadURL(request.toString());
  return true;
}
