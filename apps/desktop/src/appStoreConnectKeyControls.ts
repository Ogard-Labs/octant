/**
 * The desktop's side of entering the App Store Connect API key
 * (docs/design/apple-devices.md § Distribution). A window's request goes to
 * the host's fixed local route with the desktop bridge secret and that
 * window's own capability; the host validates the key, stores it in the
 * credential broker, and answers only `stored`, `missing`, `removed`, or a
 * refusal. Main never reads, keeps, or logs the key, and a paired device never
 * reaches these routes, because only this process holds the bridge secret.
 */

export const APP_STORE_CONNECT_KEY_OPERATIONS = {
  status: "/api/desktop/app-store-connect-key/status",
  set: "/api/desktop/app-store-connect-key/set",
  remove: "/api/desktop/app-store-connect-key/remove",
} as const;

export type AppStoreConnectKeyOperation = keyof typeof APP_STORE_CONNECT_KEY_OPERATIONS;

export interface AppStoreConnectKeyAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** A `.p8` key and its two ids fit well inside this; the host bounds it again. */
const MAX_BODY_BYTES = 8 * 1_024;

export function isAppStoreConnectKeyOperation(
  value: unknown,
): value is AppStoreConnectKeyOperation {
  return typeof value === "string" && Object.hasOwn(APP_STORE_CONNECT_KEY_OPERATIONS, value);
}

export class AppStoreConnectKeyControlFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppStoreConnectKeyControlFailure";
  }
}

export interface AppStoreConnectKeyControlRuntime {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Sends one operation to the host. A refusal is an answer, returned with its
 * status; only a request that never reached the host, or an operation or body
 * a window may not send, throws.
 */
export async function sendAppStoreConnectKeyOperation(
  runtime: AppStoreConnectKeyControlRuntime,
  operation: unknown,
  body: unknown,
): Promise<AppStoreConnectKeyAnswer> {
  if (!isAppStoreConnectKeyOperation(operation)) {
    throw new AppStoreConnectKeyControlFailure(
      "Octant refused an unknown App Store Connect key request.",
    );
  }
  const encoded = JSON.stringify(body ?? {});
  if (Buffer.byteLength(encoded, "utf8") > MAX_BODY_BYTES) {
    throw new AppStoreConnectKeyControlFailure(
      "Octant refused an App Store Connect key request that is too large.",
    );
  }
  let response: Response;
  try {
    response = await runtime.fetch(
      new URL(APP_STORE_CONNECT_KEY_OPERATIONS[operation], runtime.serverUrl),
      {
        method: "POST",
        redirect: "error",
        headers: {
          "x-octant-desktop-secret": runtime.desktopBridgeSecret,
          "x-octant-window-capability": runtime.windowCapability,
          "content-type": "application/json",
        },
        body: encoded,
      },
    );
  } catch {
    throw new AppStoreConnectKeyControlFailure("Octant could not reach the host.");
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
