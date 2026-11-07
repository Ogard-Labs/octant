import {
  decodeHumanBrowserRequest,
  decodeHumanBrowserResult,
  type HumanBrowserRequest,
  type HumanBrowserResult,
  MAX_HUMAN_FRAME_BYTES,
} from "@octant/contracts/browser-presentation";
import { bindFetchPort } from "./bindFetchPort";

export function createBrowserPresentationClient(options: {
  readonly baseUrl: string;
  readonly windowCapability: string;
  readonly rendererIdentity: string;
  readonly fetch: typeof globalThis.fetch;
}) {
  const origin = new URL(options.baseUrl);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.origin !== options.baseUrl
  )
    throw new TypeError("Browser presentation requires the authenticated host origin.");
  const fetch = bindFetchPort(options.fetch);
  return {
    async execute(request: HumanBrowserRequest, signal?: AbortSignal): Promise<HumanBrowserResult> {
      const deadline = AbortSignal.timeout(2_000);
      const lifetime = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      const response = await fetch(new URL("/api/browser/human-presentation", origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
          "x-octant-human-presentation": options.rendererIdentity,
        },
        body: JSON.stringify(decodeHumanBrowserRequest(request)),
        signal: lifetime,
        redirect: "error",
      });
      if (!response.ok) return { status: "refused" };
      if (response.body === null) return { status: "refused" };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const aborted = () => {
        void reader.cancel().catch(() => {});
      };
      lifetime.addEventListener("abort", aborted, { once: true });
      try {
        if (lifetime.aborted) return { status: "refused" };
        while (true) {
          const part = await reader.read();
          if (lifetime.aborted) return { status: "refused" };
          if (part.done) break;
          bytes += part.value.byteLength;
          // One bounded JPEG as base64 plus its envelope, never an unbounded body.
          if (bytes > MAX_HUMAN_FRAME_BYTES * 2) return { status: "refused" };
          chunks.push(part.value);
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return decodeHumanBrowserResult(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
        );
      } finally {
        lifetime.removeEventListener("abort", aborted);
        void reader.cancel().catch(() => {});
      }
    },
  };
}
