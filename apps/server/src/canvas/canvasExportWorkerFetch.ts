import { request } from "node:https";
import { isIP } from "node:net";
import type { CanvasExportWorkerMessage } from "@octant/plugin-api/canvas-export-worker";
import { defaultResolveAll, isPrivateAddress } from "../harness/nativeHarnessWebFetch";

type FetchRequest = Extract<CanvasExportWorkerMessage, { readonly kind: "fetch" }>;
export interface CanvasExportWorkerFetchResponse {
  readonly kind: "fetch-response";
  readonly id: number;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBase64: string;
}

/** Exact-origin, public-address HTTPS only. Redirects are returned, never followed. */
export function canvasExportWorkerFetch(
  input: FetchRequest,
  origins: ReadonlyArray<string>,
  current: () => boolean,
  signal: AbortSignal,
): Promise<CanvasExportWorkerFetchResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !origins.includes(url.origin) ||
      !current() ||
      signal.aborted ||
      Object.keys(input.headers).length > 8 ||
      Object.keys(input.headers).some(
        (name) => !["accept", "content-type"].includes(name.toLowerCase()),
      )
    ) {
      reject(new Error("Export network request refused."));
      return;
    }
    const outgoing = request(
      url,
      {
        method: input.method,
        headers: { ...input.headers, host: url.host },
        signal,
        lookup: (hostname, _options, callback) => {
          defaultResolveAll(hostname).then(
            (addresses) => {
              if (
                !current() ||
                signal.aborted ||
                addresses.length === 0 ||
                addresses.some(isPrivateAddress)
              ) {
                callback(new Error("Export address refused."), []);
                return;
              }
              callback(
                null,
                addresses.map((address) => ({ address, family: isIP(address) })),
              );
            },
            () => callback(new Error("Export address unavailable."), []),
          );
        },
      },
      (incoming) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1_048_576 || !current()) {
            incoming.destroy(new Error("Export response refused."));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          if (!current()) {
            reject(new Error("Export authorization changed."));
            return;
          }
          resolve({
            kind: "fetch-response",
            id: input.id,
            status: incoming.statusCode ?? 502,
            headers: {
              "content-type": incoming.headers["content-type"] ?? "application/octet-stream",
            },
            bodyBase64: Buffer.concat(chunks).toString("base64"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (!current()) {
      outgoing.destroy(new Error("Export authorization changed."));
      return;
    }
    outgoing.end(
      input.bodyBase64 === undefined ? undefined : Buffer.from(input.bodyBase64, "base64"),
    );
  });
}
