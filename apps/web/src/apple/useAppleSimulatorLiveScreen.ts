import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { AppleScreenStreamRequest } from "@octant/contracts/apple-toolchain-rpc";
import { useCallback, useEffect, useRef, useState } from "react";

export type AppleSimulatorLiveScreen =
  /** Not asked for: the frame is not live, or this client cannot attach one. */
  | { readonly status: "off" }
  | { readonly status: "connecting" }
  | {
      readonly status: "live";
      /** The device's screen in pixels; a tap is a point in this space. */
      readonly screen: { readonly width: number; readonly height: number };
      /** Give the canvas that should show the screen; frames are painted onto it. */
      readonly attach: (canvas: HTMLCanvasElement | null) => void;
    }
  /** The host has no live view right now; the captured still is what there is. */
  | { readonly status: "unavailable"; readonly message: string };

interface DecodedFrame {
  readonly width: number;
  readonly height: number;
  close(): void;
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;
/** A view that lasted this long was working; one that ended sooner was not. */
const HEALTHY_VIEW_MS = 10_000;

/**
 * Watches a booted Simulator's screen for as long as the pane shows it. The
 * host sends a frame only when the screen changes, so a still device costs
 * nothing; leaving the pane aborts the request, which stops the stream at its
 * source. A view that ends on its own is retried a few times — a helper is
 * restarted on demand — and then reported unavailable so the still can show.
 */
export function useAppleSimulatorLiveScreen(options: {
  readonly client: AppleToolchainClient;
  readonly request?: AppleScreenStreamRequest;
  readonly enabled: boolean;
  /** Replaceable where `createImageBitmap` does not exist. */
  readonly decode?: (jpeg: Uint8Array) => Promise<DecodedFrame>;
}): AppleSimulatorLiveScreen {
  const { client, enabled, request } = options;
  const decode = options.decode ?? decodeJpeg;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestRef = useRef<{ readonly key: string; readonly frame: DecodedFrame } | undefined>(
    undefined,
  );
  // What is known is known about one request. The state carries that request's
  // key, and a render for any other request reads as not yet connected: an
  // effect only runs after the render, and until it does the previous device's
  // picture and size would sit under the new device's name and input.
  const [known, setKnown] = useState<{
    readonly key: string | undefined;
    readonly state:
      | { readonly status: "off" | "connecting" }
      | {
          readonly status: "live";
          readonly screen: { readonly width: number; readonly height: number };
        }
      | { readonly status: "unavailable"; readonly message: string };
  }>({ key: undefined, state: { status: "off" } });
  const requestKey = request === undefined ? undefined : JSON.stringify(request);
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;

  const attach = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    const latest = latestRef.current;
    if (canvas !== null && latest !== undefined && latest.key === requestKeyRef.current) {
      paint(canvas, latest.frame);
    }
  }, []);

  useEffect(() => {
    if (!enabled || request === undefined || requestKey === undefined) {
      setKnown({ key: requestKey, state: { status: "off" } });
      return;
    }
    const key = requestKey;
    const setState = (state: (typeof known)["state"]) => setKnown({ key, state });
    const controller = new AbortController();
    const signal = controller.signal;
    setState({ status: "connecting" });
    void (async () => {
      let failures = 0;
      let everLive = false;
      let stopped = "The live Simulator view stopped.";
      while (!signal.aborted) {
        const watch = await client.watchScreen(request, signal);
        if (signal.aborted) return;
        let painted = false;
        const startedAt = Date.now();
        if (watch.status === "failed") {
          // On the first request a refusal is the host's answer — no desktop
          // app, not booted — and the still shows at once. After a view has
          // been up it is more often a helper being restarted, so it counts as
          // one attempt and the back-off below goes on.
          if (!everLive) {
            setState({ status: "unavailable", message: watch.message });
            return;
          }
          stopped = watch.message;
        } else {
          for await (const jpeg of watch.frames) {
            if (signal.aborted) return;
            let frame: DecodedFrame;
            try {
              frame = await decode(jpeg);
            } catch {
              continue;
            }
            // Decoding took time, and the pane may have moved to another thread
            // or Simulator meanwhile. A picture of the old one must not be drawn
            // on the new pane's canvas or set the size its taps are measured by.
            if (signal.aborted) {
              frame.close();
              return;
            }
            latestRef.current?.frame.close();
            latestRef.current = { key, frame };
            if (canvasRef.current !== null) paint(canvasRef.current, frame);
            if (!painted) {
              painted = true;
              everLive = true;
              setState({ status: "live", screen: watch.screen });
            }
          }
        }
        if (signal.aborted) return;
        // Every view sends a first frame, so a first frame proves nothing: a
        // helper that dies right after it would be asked for again forever.
        // Only a view that stayed up earns a fresh count.
        if (Date.now() - startedAt >= HEALTHY_VIEW_MS) failures = 0;
        const delay = RECONNECT_DELAYS_MS[failures];
        if (delay === undefined) {
          setState({ status: "unavailable", message: stopped });
          return;
        }
        failures += 1;
        setState({ status: "connecting" });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();
    return () => {
      controller.abort();
      latestRef.current?.frame.close();
      latestRef.current = undefined;
    };
    // `requestKey` stands in for `request`: callers rebuild the object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, decode, enabled, requestKey]);

  const state: (typeof known)["state"] =
    known.key === requestKey
      ? known.state
      : { status: enabled && request !== undefined ? "connecting" : "off" };
  return state.status === "live" ? { ...state, attach } : state;
}

async function decodeJpeg(jpeg: Uint8Array): Promise<DecodedFrame> {
  return createImageBitmap(new Blob([jpeg.slice()], { type: "image/jpeg" }));
}

function paint(canvas: HTMLCanvasElement, frame: DecodedFrame): void {
  if (canvas.width !== frame.width) canvas.width = frame.width;
  if (canvas.height !== frame.height) canvas.height = frame.height;
  // The decoder's result is an ImageBitmap outside tests; a stand-in has no pixels to draw.
  if (typeof ImageBitmap === "undefined" || !(frame instanceof ImageBitmap)) return;
  canvas.getContext("2d")?.drawImage(frame, 0, 0);
}
