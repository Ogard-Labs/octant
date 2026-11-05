import { bindPrincipalRouteContext, readPrincipalRouteContext } from "./principalRouteContext";
import { WINDOW_CAPABILITY_HEADER } from "./clientPrincipal";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

/** Expiry cuts off a native client's held reads as well as its next request. */
export async function dispatchNativeWindowRequest(
  request: Request,
  store: WindowAuthorityStore,
  now: number,
  dispatch: (request: Request) => Promise<Response | undefined>,
): Promise<Response | undefined> {
  if (readPrincipalRouteContext(request)?.principal.kind === "remote-device")
    return dispatch(request);
  let leaseSignal: AbortSignal | undefined;
  try {
    leaseSignal = store.nativeRequestSignal(
      request.headers.get(WINDOW_CAPABILITY_HEADER) ?? "",
      now,
    );
  } catch (error) {
    if (error instanceof WindowAuthorityError) return expired();
    throw error;
  }
  if (leaseSignal === undefined) return dispatch(request);
  const context = readPrincipalRouteContext(request);
  const signal = AbortSignal.any([
    request.signal,
    leaseSignal,
    ...(context?.abortSignal === undefined ? [] : [context.abortSignal]),
  ]);
  const currentRequest = new Request(request, { signal });
  if (context !== undefined)
    bindPrincipalRouteContext(currentRequest, { ...context, abortSignal: signal });
  const response = await dispatch(currentRequest);
  if (signal.aborted) {
    void response?.body?.cancel().catch(() => undefined);
    return expired();
  }
  if (response?.body === null || response === undefined) return response;
  const reader = response.body.getReader();
  let finished = false;
  let abort = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        controller.error(new DOMException("Native window request ended.", "AbortError"));
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      if (finished) return;
      try {
        const next = await reader.read();
        // A producer may finish after cancellation. No bytes cross the lease
        // after an awaited read, even if that producer ignores its signal.
        if (finished || signal.aborted) return;
        if (next.done) {
          finished = true;
          signal.removeEventListener("abort", abort);
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        controller.error(error);
      }
    },
    async cancel(reason) {
      finished = true;
      signal.removeEventListener("abort", abort);
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function expired(): Response {
  return Response.json(
    { category: "unauthorized", message: "Window authority is invalid." },
    { status: 401 },
  );
}
