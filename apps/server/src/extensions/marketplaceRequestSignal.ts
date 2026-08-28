export {
  MARKETPLACE_FETCH_USER_AGENT,
  MARKETPLACE_FETCH_ALLOWED_HEADER_NAMES,
  MarketplaceFetchesDisabledError,
  createMarketplaceFetch,
  marketplaceRequestHeaders,
} from "./marketplaceHttps";

const DEFAULT_MARKETPLACE_REQUEST_TIMEOUT_MS = 30_000;

export function createMarketplaceRequestSignal(
  callerSignal?: AbortSignal,
  timeoutMs = DEFAULT_MARKETPLACE_REQUEST_TIMEOUT_MS,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener("abort", abort, { once: true });
  // Close the check/listener race if the caller aborts between those operations.
  if (callerSignal?.aborted) controller.abort();
  const timer = setTimeout(abort, Math.max(1_000, Math.min(timeoutMs, 60_000)));
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abort);
    },
  };
}

export async function withMarketplaceRequest<T>(
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const request = createMarketplaceRequestSignal(callerSignal);
  try {
    return await run(request.signal);
  } finally {
    request.dispose();
  }
}
