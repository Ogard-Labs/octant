import { decodeHostAnswer } from "@octant/contracts";
import { ActiveWorkFailure, ActiveWorkRow, type ActiveWork } from "@octant/contracts/active-work";

export interface ActiveWorkClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /** A window's own host only; a paired session carries none. */
  readonly windowCapability?: string;
}

/**
 * What one host answered. `unsupported` is a host older than this read: it is
 * reachable and says nothing, which is not the same as having no work.
 */
export type ActiveWorkAnswer =
  | { readonly status: "answered"; readonly work: ActiveWork }
  | { readonly status: "unsupported" }
  | { readonly status: "refused" }
  | { readonly status: "unreachable" };

export interface ActiveWorkClient {
  read(signal?: AbortSignal): Promise<ActiveWorkAnswer>;
}

const decodeRow = decodeHostAnswer(ActiveWorkRow);
const decodeFailure = decodeHostAnswer(ActiveWorkFailure);

/** Reads what one host says about its own work; it asks no host about another. */
export function createActiveWorkClient(options: ActiveWorkClientOptions): ActiveWorkClient {
  const url = new URL("/api/active-work", options.baseUrl).toString();
  return {
    async read(signal) {
      let response: Response;
      let body: unknown;
      try {
        response = await options.fetch(url, {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability ?? "" },
          ...(signal === undefined ? {} : { signal }),
        });
        body = await response.json().catch(() => undefined);
      } catch {
        return { status: "unreachable" };
      }
      if (response.ok) {
        const work = decodeWork(body);
        return work === undefined ? { status: "unreachable" } : { status: "answered", work };
      }
      // A host that knows this read refuses it in its own words; an older one,
      // or its listener, refuses the path with something else.
      try {
        const failure = decodeFailure(body);
        return { status: failure.code === "unauthorized" ? "refused" : "unreachable" };
      } catch {
        return { status: response.status >= 500 ? "unreachable" : "unsupported" };
      }
    },
  };
}

/**
 * A row this build cannot read (a kind a later host added) is left out, so the
 * rest of the answer still shows.
 */
function decodeWork(body: unknown): ActiveWork | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { rows, truncated } = body as { readonly rows?: unknown; readonly truncated?: unknown };
  if (!Array.isArray(rows)) return undefined;
  return {
    rows: rows.flatMap((row: unknown) => {
      try {
        return [decodeRow(row)];
      } catch {
        return [];
      }
    }),
    truncated: truncated === true,
  };
}
