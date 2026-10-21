import {
  CANVAS_PUBLIC_SHARE_WIRE_VERSION,
  decodeCanvasPublicShareCreated,
  decodeCanvasPublicShareRefusal,
  decodeCanvasPublicShareRevoked,
  decodeCanvasPublicShareUpdated,
  type CanvasPublicShareCreated,
  type CanvasPublicShareDocument,
  type CanvasPublicShareId,
  type CanvasPublicShareRefusalCode,
  type CanvasPublicShareServiceUrl,
  type CanvasPublicShareUpdated,
} from "@octant/contracts/canvas-public-share";
import type { CanvasExportLinkExpiry } from "@octant/contracts/canvas-export";

/**
 * How the host reaches the public Canvas share service.
 *
 * This is the only code that sends anything there, and it is reached only from
 * the Public link export destination after the person approved a card, and
 * from revoke. Tests replace it; nothing here runs at host start.
 */
export type CanvasPublicShareCallOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "refused";
      readonly code: CanvasPublicShareRefusalCode;
      readonly message: string;
    }
  /** No answer, or one this host cannot read: whether it happened is unknown. */
  | { readonly kind: "unreachable" };

export interface CanvasPublicShareServicePort {
  readonly create: (input: {
    readonly serviceUrl: CanvasPublicShareServiceUrl;
    readonly document: CanvasPublicShareDocument;
    readonly expiry: CanvasExportLinkExpiry;
    readonly password?: string;
  }) => Promise<CanvasPublicShareCallOutcome<CanvasPublicShareCreated>>;
  readonly update: (input: {
    readonly serviceUrl: CanvasPublicShareServiceUrl;
    readonly shareId: CanvasPublicShareId;
    readonly ownerSecret: string;
    readonly document: CanvasPublicShareDocument;
    readonly expiry: CanvasExportLinkExpiry;
    readonly password?: string;
  }) => Promise<CanvasPublicShareCallOutcome<CanvasPublicShareUpdated>>;
  readonly revoke: (input: {
    readonly serviceUrl: CanvasPublicShareServiceUrl;
    readonly shareId: CanvasPublicShareId;
    readonly ownerSecret: string;
  }) => Promise<CanvasPublicShareCallOutcome<{ readonly shareId: CanvasPublicShareId }>>;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** The port over HTTPS (or loopback HTTP), with the platform `fetch`. */
export function createHttpCanvasPublicShareServicePort(
  fetchImpl: typeof fetch = globalThis.fetch,
): CanvasPublicShareServicePort {
  const call = async <T>(
    url: URL,
    init: { readonly method: string; readonly body?: unknown; readonly ownerSecret?: string },
    decode: (value: unknown) => T,
  ): Promise<CanvasPublicShareCallOutcome<T>> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.ownerSecret === undefined
            ? {}
            : { authorization: `Bearer ${init.ownerSecret}` }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      return { kind: "unreachable" };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { kind: "unreachable" };
    }
    if (response.ok) {
      try {
        return { kind: "ok", value: decode(json) };
      } catch {
        return { kind: "unreachable" };
      }
    }
    try {
      const refusal = decodeCanvasPublicShareRefusal(json);
      return { kind: "refused", code: refusal.code, message: refusal.message };
    } catch {
      return { kind: "unreachable" };
    }
  };
  const shareUrl = (serviceUrl: string, shareId: CanvasPublicShareId) =>
    new URL(`/api/v1/shares/${encodeURIComponent(String(shareId))}`, serviceUrl);

  return {
    create: (input) =>
      call(
        new URL("/api/v1/shares", input.serviceUrl),
        {
          method: "POST",
          body: {
            schemaVersion: CANVAS_PUBLIC_SHARE_WIRE_VERSION,
            kind: "canvas-public-share-create",
            document: input.document,
            expiry: input.expiry,
            ...(input.password === undefined ? {} : { password: input.password }),
          },
        },
        decodeCanvasPublicShareCreated,
      ),
    update: (input) =>
      call(
        shareUrl(input.serviceUrl, input.shareId),
        {
          method: "PUT",
          ownerSecret: input.ownerSecret,
          body: {
            schemaVersion: CANVAS_PUBLIC_SHARE_WIRE_VERSION,
            kind: "canvas-public-share-update",
            document: input.document,
            expiry: input.expiry,
            ...(input.password === undefined ? {} : { password: input.password }),
          },
        },
        decodeCanvasPublicShareUpdated,
      ),
    revoke: (input) =>
      call(
        shareUrl(input.serviceUrl, input.shareId),
        { method: "DELETE", ownerSecret: input.ownerSecret },
        decodeCanvasPublicShareRevoked,
      ),
  };
}
