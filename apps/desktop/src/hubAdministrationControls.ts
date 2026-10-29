/**
 * The desktop's side of Settings › Hub: each operation a window may ask for is
 * one of the host's loopback hub administration routes, sent with the desktop
 * bridge secret and that window's own capability. Canonical:
 * docs/design/hub-and-spokes.md.
 *
 * Main forwards only the operations named here, to their fixed paths, and only
 * after the body decodes against that operation's contract schema, so a window
 * cannot send arbitrary JSON or reach an arbitrary path. A paired device never
 * reaches these routes, because only this process holds the bridge secret.
 */

import {
  decodeConfirmNewMembersRequest,
  decodeHubGrant,
  decodeHubLeaveRequest,
  decodeHubPromoteRequest,
  decodeHubStandbyOrderRequest,
  decodeHubWakeHardwareAddressRequest,
  decodeHubWakeSwitchRequest,
  decodeOwnerAdditionRequest,
  decodeOwnerAlertRequest,
  decodeOwnerMemberRequest,
  decodeOwnerRemovalRequest,
} from "@octant/contracts";
import { Schema } from "effect";

type BodyDecoder = (value: unknown) => unknown;

interface HubAdministrationRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  /** Absent when the operation takes no body. */
  readonly decodeBody?: BodyDecoder;
}

const JoinCodeBody = Schema.Struct({ owner: Schema.Boolean }).annotations({
  onExcessProperty: "error",
});
const JoinBody = Schema.Struct({ code: Schema.String.pipe(Schema.maxLength(4_096)) }).annotations({
  onExcessProperty: "error",
});

const CertificateBody = Schema.Struct({
  action: Schema.Literal("enable", "disable", "renew"),
  acknowledgedCertificateTransparency: Schema.optional(Schema.Boolean),
}).annotations({ onExcessProperty: "error" });

export const HUB_ADMINISTRATION_OPERATIONS = {
  status: { method: "GET", path: "/api/desktop/hub/status" },
  enable: { method: "POST", path: "/api/desktop/hub/enable" },
  disable: { method: "POST", path: "/api/desktop/hub/disable" },
  "join-code": {
    method: "POST",
    path: "/api/desktop/hub/join-codes",
    decodeBody: Schema.decodeUnknownSync(JoinCodeBody),
  },
  remove: {
    method: "POST",
    path: "/api/desktop/hub/members/remove",
    decodeBody: decodeHubLeaveRequest,
  },
  join: {
    method: "POST",
    path: "/api/desktop/hub/join",
    decodeBody: Schema.decodeUnknownSync(JoinBody),
  },
  "join-finish": { method: "POST", path: "/api/desktop/hub/join/finish" },
  grant: { method: "POST", path: "/api/desktop/hub/grant", decodeBody: decodeHubGrant },
  leave: { method: "POST", path: "/api/desktop/hub/leave" },
  "owners-add": {
    method: "POST",
    path: "/api/desktop/hub/owners/add",
    decodeBody: decodeOwnerAdditionRequest,
  },
  "owners-remove": {
    method: "POST",
    path: "/api/desktop/hub/owners/remove",
    decodeBody: decodeOwnerRemovalRequest,
  },
  "confirm-new-members": {
    method: "POST",
    path: "/api/desktop/hub/confirm-new-members",
    decodeBody: decodeConfirmNewMembersRequest,
  },
  "confirm-member": {
    method: "POST",
    path: "/api/desktop/hub/members/confirm",
    decodeBody: decodeOwnerMemberRequest,
  },
  "alert-dismiss": {
    method: "POST",
    path: "/api/desktop/hub/alerts/dismiss",
    decodeBody: decodeOwnerAlertRequest,
  },
  "alert-remove": {
    method: "POST",
    path: "/api/desktop/hub/alerts/remove",
    decodeBody: decodeOwnerAlertRequest,
  },
  "certificate-status": { method: "GET", path: "/api/desktop/hub/certificate" },
  certificate: {
    method: "POST",
    path: "/api/desktop/hub/certificate",
    decodeBody: (value) =>
      Schema.decodeUnknownSync(CertificateBody)(value, { onExcessProperty: "error" }),
  },
  "standby-order": {
    method: "POST",
    path: "/api/desktop/hub/standby-order",
    decodeBody: decodeHubStandbyOrderRequest,
  },
  promote: {
    method: "POST",
    path: "/api/desktop/hub/promote",
    decodeBody: decodeHubPromoteRequest,
  },
  wake: {
    method: "POST",
    path: "/api/desktop/hub/wake",
    decodeBody: decodeHubWakeSwitchRequest,
  },
  "wake-hardware-address": {
    method: "POST",
    path: "/api/desktop/hub/wake/hardware-address",
    decodeBody: decodeHubWakeHardwareAddressRequest,
  },
} as const satisfies Readonly<Record<string, HubAdministrationRoute>>;

export type HubAdministrationOperation = keyof typeof HUB_ADMINISTRATION_OPERATIONS;

export interface HubAdministrationAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** The largest body a window may send; the server's own bound is the same. */
const MAX_BODY_BYTES = 64 * 1_024;

export function isHubAdministrationOperation(value: unknown): value is HubAdministrationOperation {
  return typeof value === "string" && Object.hasOwn(HUB_ADMINISTRATION_OPERATIONS, value);
}

export class HubAdministrationControlFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubAdministrationControlFailure";
  }
}

export interface HubAdministrationControlRuntime {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly fetch: typeof globalThis.fetch;
}

/** A request the desktop refuses before the host sees it, in the host's own refusal shape. */
function refusal(status: 400 | 413, message: string): HubAdministrationAnswer {
  return { status, body: { category: "invalid", message } };
}

/**
 * Sends one operation to the host. A refusal, whether the desktop's or the
 * host's, is an answer returned with its status; only a request that never
 * reached the host throws.
 */
export async function sendHubAdministrationOperation(
  runtime: HubAdministrationControlRuntime,
  operation: unknown,
  body: unknown,
): Promise<HubAdministrationAnswer> {
  if (!isHubAdministrationOperation(operation)) {
    return refusal(400, "Octant refused an unknown hub request.");
  }
  const route: HubAdministrationRoute = HUB_ADMINISTRATION_OPERATIONS[operation];
  let encoded: string | undefined;
  if (route.decodeBody !== undefined) {
    let decoded: unknown;
    try {
      decoded = route.decodeBody(body);
    } catch {
      return refusal(400, "Octant refused a hub request that is not valid.");
    }
    encoded = JSON.stringify(decoded);
    if (Buffer.byteLength(encoded, "utf8") > MAX_BODY_BYTES) {
      return refusal(413, "Octant refused a hub request that is too large.");
    }
  } else if (body !== undefined) {
    return refusal(400, "Octant refused a hub request that takes no body.");
  }
  let response: Response;
  try {
    response = await runtime.fetch(new URL(route.path, runtime.serverUrl), {
      method: route.method,
      redirect: "error",
      headers: {
        "x-octant-desktop-secret": runtime.desktopBridgeSecret,
        "x-octant-window-capability": runtime.windowCapability,
        ...(encoded === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(encoded === undefined ? {} : { body: encoded }),
    });
  } catch {
    throw new HubAdministrationControlFailure("Octant hub controls are unavailable.");
  }
  const text = await response.text().catch(() => "");
  let value: unknown = null;
  try {
    value = text === "" ? null : JSON.parse(text);
  } catch {
    value = null;
  }
  return { status: response.status, body: value };
}
