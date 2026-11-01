import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserCapture, BrowserThreadId } from "@octant/contracts";
import { useEffect, useState } from "react";

export function BrowserCaptureImage(props: {
  readonly capture: BrowserCapture;
  readonly client: BrowserAutomationClient;
  readonly threadId: BrowserThreadId;
  readonly className: string;
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

  if (unavailable) {
    return <span aria-label="Capture is unavailable" className={props.className} role="img" />;
  }
  if (dataUrl === undefined) return <span aria-hidden="true" className={props.className} />;
  // The contract constrains the data URL to an image, so this never loads a
  // network or local resource.
  return (
    <img
      alt={`Capture of ${captureLabel(props.capture)}`}
      className={props.className}
      draggable={false}
      src={dataUrl}
    />
  );
}

export function captureLabel(capture: BrowserCapture): string {
  return capture.title ?? capture.origin;
}
