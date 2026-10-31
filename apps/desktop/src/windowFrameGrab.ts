import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, session, type DesktopCapturerSource } from "electron";

const GRAB_TIMEOUT_MS = 15_000;

// Runs inside the hidden page. `getDisplayMedia` is answered by the main
// process with the one chosen window (see below), so the stream, and the
// single frame drawn from it, never contain another window.
const GRAB_FRAME = `(async () => {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) =>
      "requestVideoFrameCallback" in video
        ? video.requestVideoFrameCallback(() => resolve())
        : requestAnimationFrame(() => resolve()),
    );
    if (video.videoWidth === 0 || video.videoHeight === 0) return "";
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
})()`;

/**
 * Reads one frame of one window. Electron's thumbnail call reads the pixels of
 * every open window before any can be filtered out, so the capture instead
 * opens a display-media stream for the chosen source alone, in a hidden,
 * network-free page on its own in-memory session, and closes it as
 * soon as the frame is drawn. Returns PNG bytes, or undefined when the window
 * could not be read.
 */
export async function grabWindowFrame(
  source: DesktopCapturerSource,
): Promise<Uint8Array | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "octant-window-capture-"));
  // A file page is a secure context, which getDisplayMedia needs; a data URL is not.
  const page = join(directory, "capture.html");
  await writeFile(page, "<!doctype html><meta charset=utf-8><title>Octant window capture</title>");
  // No "persist:" prefix: the session lives in memory and is gone with the window.
  const capture = session.fromPartition(`octant-window-capture-${randomUUID()}`);
  // Only the media permission a display stream asks for; everything else is refused.
  capture.setPermissionCheckHandler((_contents, permission) => permission === "media");
  capture.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === "media"),
  );
  capture.setDisplayMediaRequestHandler((_request, callback) => callback({ video: source }));
  const window = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      session: capture,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await window.loadURL(pathToFileURL(page).toString());
    const dataUrl: unknown = await Promise.race([
      window.webContents.executeJavaScript(GRAB_FRAME, true),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("window capture timed out")), GRAB_TIMEOUT_MS);
      }),
    ]);
    const prefix = "data:image/png;base64,";
    if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) return undefined;
    return Buffer.from(dataUrl.slice(prefix.length), "base64");
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
    await capture.clearStorageData().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
