import {
  decodeHumanBrowserRequest,
  type HumanBrowserRequest,
} from "@octant/contracts/browser-presentation";
import type { WindowId } from "@octant/contracts";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { WINDOW_CAPABILITY_HEADER } from "../clientPrincipal";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { BrowserRuntimePort } from "./browserRuntimePort";

export function createNativeBrowserPresentationRoutes(options: {
  readonly store: WindowAuthorityStore;
  readonly runtime: BrowserRuntimePort | Pick<BrowserRuntimePort, "humanPresentation">;
  readonly owns: (windowId: WindowId, request: HumanBrowserRequest) => boolean;
  readonly now: () => number;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/browser/human-presentation") return undefined;
    const refused = () => Response.json({ status: "refused" }, { status: 403 });
    if (request.method !== "POST" || url.search !== "") return refused();
    try {
      const principal = authenticateRoutePrincipal({
        request,
        store: options.store,
        now: options.now(),
      });
      if (principal.principal.kind !== "local-window") return refused();
      const capability = request.headers.get(WINDOW_CAPABILITY_HEADER) ?? "";
      const rendererWindowId = options.store.authenticateRenderer(
        capability,
        request.headers.get("x-octant-human-presentation") ?? "",
        options.now(),
      );
      const authority = options.store.nativePresentationAuthority(capability, options.now());
      if (
        authority === undefined ||
        String(rendererWindowId) !== String(authority.windowId) ||
        String(authority.windowId) !== String(principal.scopeId) ||
        authority.source.generation !== principal.principal.capabilityGeneration ||
        options.runtime.humanPresentation === undefined
      )
        return refused();
      const signal = AbortSignal.any([
        request.signal,
        authority.signal,
        AbortSignal.timeout(2_000),
        ...(principal.abortSignal === undefined ? [] : [principal.abortSignal]),
      ]);
      const reader = request.body?.getReader();
      if (reader === undefined) return refused();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          if (signal.aborted) return refused();
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 16_384) {
            void reader.cancel().catch(() => undefined);
            return refused();
          }
          chunks.push(next.value);
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
      if (signal.aborted) return refused();
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const command = decodeHumanBrowserRequest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      );
      const bound = authenticateRoutePrincipal({
        request,
        store: options.store,
        now: options.now(),
        body: command,
      });
      if (
        String(bound.scopeId) !== String(authority.windowId) ||
        !options.owns(authority.windowId, command)
      )
        return refused();
      const result = await options.runtime.humanPresentation(command, authority.windowId, signal);
      const current = options.store.nativePresentationAuthority(capability, options.now());
      if (
        signal.aborted ||
        current?.signal !== authority.signal ||
        !options.owns(authority.windowId, command)
      )
        return refused();
      return Response.json(result);
    } catch {
      return refused();
    }
  };
}
