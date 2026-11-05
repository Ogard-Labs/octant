import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserCapture, BrowserThreadId } from "@octant/contracts";
import { browserRecordingStillFrame } from "@octant/domain";
import { Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export function BrowserCaptureImage(props: {
  readonly capture: BrowserCapture;
  readonly client: BrowserAutomationClient;
  readonly threadId: BrowserThreadId;
  readonly className: string;
  /**
   * Whether a recording moves. A recording is shown still (its first frame)
   * unless the person opened it to play, so a thread with recordings never
   * moves by itself. A screenshot ignores this.
   */
  readonly play?: boolean;
}) {
  const [dataUrl, setDataUrl] = useState<string | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const readCapture = props.client.readCapture;
    setDataUrl(undefined);
    setUnavailable(false);
    if (readCapture === undefined) return;
    const controller = new AbortController();
    void readCapture
      .call(
        props.client,
        { threadId: props.threadId, captureId: props.capture.captureId },
        controller.signal,
      )
      .then((image) => {
        if (!controller.signal.aborted) setDataUrl(image.dataUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, [props.capture.captureId, props.client, props.threadId]);

  const recording = props.capture.recording !== undefined;
  const still = useMemo(
    () => (recording && dataUrl !== undefined ? browserCaptureStill(dataUrl) : undefined),
    [dataUrl, recording],
  );

  if (unavailable) {
    return <span aria-label="Capture is unavailable" className={props.className} role="img" />;
  }
  if (dataUrl === undefined) return <span aria-hidden="true" className={props.className} />;
  const shown = recording && props.play !== true ? (still ?? dataUrl) : dataUrl;
  // The contract constrains the data URL to an image, so this never loads a
  // network or local resource.
  return (
    <img
      alt={`${recording ? "Recording" : "Capture"} of ${captureLabel(props.capture)}`}
      className={props.className}
      draggable={false}
      src={shown}
    />
  );
}

/**
 * The play mark over a recording's still picture: a shape, not only a word,
 * so a recording reads as one at a glance, with its length beside it.
 */
export function BrowserRecordingBadge(props: { readonly capture: BrowserCapture }) {
  const recording = props.capture.recording;
  if (recording === undefined) return null;
  return (
    <span aria-hidden="true" className="browser-capture__badge">
      <Play className="browser-capture__badge-icon" size={12} strokeWidth={2.5} />
      {recordingLength(recording.durationMs)}
    </span>
  );
}

export function captureLabel(capture: BrowserCapture): string {
  return capture.title ?? capture.origin;
}

/** "2.3 s": a recording's length as the badge and the caption say it. */
export function recordingLength(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)} s`;
}

/** The first frame of a recording as a still image data URL; undefined when it is not one. */
function browserCaptureStill(dataUrl: string): string | undefined {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return undefined;
  let binary: string;
  try {
    binary = atob(dataUrl.slice(comma + 1));
  } catch {
    return undefined;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const still = browserRecordingStillFrame(bytes);
  if (still === undefined) return undefined;
  let text = "";
  for (let offset = 0; offset < still.length; offset += 0x8000) {
    text += String.fromCharCode(...still.subarray(offset, offset + 0x8000));
  }
  return `data:image/png;base64,${btoa(text)}`;
}
