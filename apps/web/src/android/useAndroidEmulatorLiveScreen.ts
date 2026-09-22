import type { AndroidToolchainClient } from "@octant/client-runtime/android-toolchain-client";
import type { AndroidScreenStreamRequest } from "@octant/contracts/android-toolchain-rpc";
import { useCallback, useEffect, useRef, useState } from "react";

export type AndroidEmulatorLiveScreen =
  | { readonly status: "off" }
  | { readonly status: "connecting" }
  | {
      readonly status: "live";
      readonly screen: { readonly width: number; readonly height: number };
      readonly attach: (canvas: HTMLCanvasElement | null) => void;
    }
  | { readonly status: "unavailable"; readonly message: string };

interface DecodedFrame {
  readonly width: number;
  readonly height: number;
  close(): void;
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const HEALTHY_VIEW_MS = 10_000;
const FIRST_PICTURE_MS = 5_000;

export function useAndroidEmulatorLiveScreen(options: {
  readonly client: AndroidToolchainClient;
  readonly request?: AndroidScreenStreamRequest;
  readonly enabled: boolean;
  readonly decode?: (png: Uint8Array) => Promise<DecodedFrame>;
}): AndroidEmulatorLiveScreen {
  const { client, enabled, request } = options;
  const decode = options.decode ?? decodePng;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestRef = useRef<{ readonly key: string; readonly frame: DecodedFrame } | undefined>(
    undefined,
  );
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
      let stopped = "The live emulator view stopped.";
      while (!signal.aborted) {
        const view = new AbortController();
        const endView = () => view.abort();
        signal.addEventListener("abort", endView, { once: true });
        const watch = await client.watchScreen(request, view.signal);
        if (signal.aborted) return;
        let painted = false;
        const startedAt = Date.now();
        if (watch.status === "failed") {
          if (!everLive) {
            setState({ status: "unavailable", message: watch.message });
            return;
          }
          stopped = watch.message;
        } else {
          const noPicture = setTimeout(() => {
            stopped = "The live emulator view showed no picture.";
            endView();
          }, FIRST_PICTURE_MS);
          const givenUp = new Promise<undefined>((resolve) => {
            view.signal.addEventListener("abort", () => resolve(undefined), { once: true });
          });
          try {
            for await (const png of watch.frames) {
              if (view.signal.aborted) break;
              const decoding = decode(png);
              let frame: DecodedFrame | undefined;
              try {
                frame = await Promise.race([decoding, givenUp]);
              } catch {
                continue;
              }
              if (frame === undefined) {
                void decoding.then(
                  (tooLate) => tooLate.close(),
                  () => undefined,
                );
                break;
              }
              if (view.signal.aborted) {
                frame.close();
                break;
              }
              latestRef.current?.frame.close();
              latestRef.current = { key, frame };
              if (canvasRef.current !== null) paint(canvasRef.current, frame);
              if (!painted) {
                painted = true;
                everLive = true;
                clearTimeout(noPicture);
                setState({ status: "live", screen: watch.screen });
              }
            }
          } finally {
            clearTimeout(noPicture);
          }
        }
        signal.removeEventListener("abort", endView);
        endView();
        if (signal.aborted) return;
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
  }, [client, decode, enabled, requestKey]);

  const state: (typeof known)["state"] =
    known.key === requestKey
      ? known.state
      : { status: enabled && request !== undefined ? "connecting" : "off" };
  return state.status === "live" ? { ...state, attach } : state;
}

async function decodePng(png: Uint8Array): Promise<DecodedFrame> {
  return createImageBitmap(new Blob([png.slice()], { type: "image/png" }));
}

function paint(canvas: HTMLCanvasElement, frame: DecodedFrame): void {
  if (canvas.width !== frame.width) canvas.width = frame.width;
  if (canvas.height !== frame.height) canvas.height = frame.height;
  if (typeof ImageBitmap === "undefined" || !(frame instanceof ImageBitmap)) return;
  canvas.getContext("2d")?.drawImage(frame, 0, 0);
}
