import { createHash, timingSafeEqual } from "node:crypto";
import type { WindowId } from "@octant/contracts";
import {
  NATIVE_MAIN_AUTHORITY_HEADER,
  type NightlyHostFeature,
} from "@octant/contracts/nightly-browser";
import { WINDOW_CAPABILITY_HEADER } from "./clientPrincipal";
import { readPrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

export { NATIVE_MAIN_AUTHORITY_HEADER };

/**
 * The closed set of brokered routes a native Nightly main may call with its
 * main-only token in place of Stable's desktop bridge secret. Every other
 * secret-gated route (hub, private listener, remote devices and pairing,
 * launch sessions, owner unlock, host identity, window registration, provider
 * sign-in and provider removal) stays secret-only. Adding a route here widens
 * what a Nightly process can do, so it needs its owning specification first.
 */
const NATIVE_MAIN_BROKERED_ROUTES = {
  "project-root-receipts": ["/api/desktop/project-binding-receipts"],
  "local-folder-receipts": ["/api/extensions/import-local-receipts"],
  "runtime-binary-receipts": ["/api/providers/discovery/binary-receipts"],
  "code-external-editor-target": ["/api/desktop/code-external-editor-target"],
  "code-checkout-open-target": ["/api/desktop/code-checkout-open-target"],
  "preview-handoff": ["/api/desktop/preview-handoff"],
  "support-bundle-save": ["/api/diagnostics/bundle/save"],
  "code-operation-approval": [
    "/api/desktop/code-operation-approval-challenges",
    "/api/desktop/code-operation-approval-confirmations",
    "/api/desktop/code-operation-approval-cancellations",
  ],
  "provider-credentials": [
    "/api/desktop/provider-credentials/status",
    "/api/desktop/provider-credentials/set",
    "/api/desktop/provider-credentials/remove",
  ],
  "provider-api-keys": [
    "/api/desktop/provider-credentials/keys/list",
    "/api/desktop/provider-credentials/keys/add",
    "/api/desktop/provider-credentials/keys/rename",
    "/api/desktop/provider-credentials/keys/replace",
    "/api/desktop/provider-credentials/keys/remove",
    "/api/desktop/provider-credentials/keys/set-active",
    "/api/desktop/provider-credentials/keys/move",
  ],
} as const satisfies Record<NightlyHostFeature, ReadonlyArray<string>>;

/** Every admitted route is a POST; the path alone never admits another method. */
export const NATIVE_MAIN_ADMITTED_ROUTES: ReadonlyArray<string> = Object.freeze(
  Object.values(NATIVE_MAIN_BROKERED_ROUTES).flat(),
);

/** What this host brokers for a native main, advertised in the window bootstrap. */
export const NATIVE_MAIN_HOST_FEATURES: ReadonlyArray<NightlyHostFeature> = Object.freeze(
  Object.keys(NATIVE_MAIN_BROKERED_ROUTES) as NightlyHostFeature[],
);

export type DesktopBrokerAdmission =
  | { readonly status: "admitted"; readonly kind: "desktop-bridge" }
  | { readonly status: "admitted"; readonly kind: "native-main"; readonly windowId: WindowId }
  | { readonly status: "refused" };

/**
 * Admit Stable's main by the bridge secret, or a native window's main by its
 * window capability plus main-only token on an allowlisted route. The caller
 * keeps its own loopback, origin and body checks and must hold a native-main
 * admission to the window it authenticated (`admitsWindow`).
 */
export function admitDesktopBroker(input: {
  readonly request: Request;
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore?: WindowAuthorityStore;
  readonly now: number;
}): DesktopBrokerAdmission {
  const refused = { status: "refused" } as const;
  // A forwarded remote request is rebuilt as loopback; its bound principal is
  // the only evidence of where it came from.
  if (readPrincipalRouteContext(input.request) !== undefined) return refused;
  if (input.request.headers.has("origin")) return refused;
  const secret = input.request.headers.get("x-octant-desktop-secret");
  if (secret !== null) {
    return input.desktopBridgeSecret !== undefined &&
      secretsEqual(input.desktopBridgeSecret, secret)
      ? { status: "admitted", kind: "desktop-bridge" }
      : refused;
  }
  const token = input.request.headers.get(NATIVE_MAIN_AUTHORITY_HEADER);
  const url = new URL(input.request.url);
  if (
    token === null ||
    input.windowAuthorityStore === undefined ||
    input.request.method !== "POST" ||
    url.search !== "" ||
    !NATIVE_MAIN_ADMITTED_ROUTES.includes(url.pathname)
  )
    return refused;
  try {
    const windowId = input.windowAuthorityStore.authenticateNativeMain(
      input.request.headers.get(WINDOW_CAPABILITY_HEADER) ?? "",
      token,
      input.now,
    );
    return { status: "admitted", kind: "native-main", windowId };
  } catch (error) {
    if (error instanceof WindowAuthorityError) return refused;
    throw error;
  }
}

/** Stable's main may name any window; a native main only its own. */
export function admitsWindow(admission: DesktopBrokerAdmission, windowId: unknown): boolean {
  if (admission.status !== "admitted") return false;
  return admission.kind === "desktop-bridge" || String(admission.windowId) === String(windowId);
}

function secretsEqual(expected: string, actual: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(expected, "utf8").digest(),
    createHash("sha256").update(actual, "utf8").digest(),
  );
}
