import { DESKTOP_IPC_CHANNELS as IPC_CHANNELS } from "./ipcChannels";

/**
 * An organization sign-in with a device code, begun from a local desktop
 * window. The host-local routes take only a caller that holds the desktop
 * secret, which main alone has, so a window reaches them through main and a
 * paired device or a remote browser, which has no such bridge, cannot. That
 * is the whole reason the code may be shown here: a code shown on a page
 * someone else can reach is how device-code phishing works.
 */
export type ProviderDeviceSignInWindowRequest =
  | { readonly kind: "begin"; readonly instance: string; readonly acknowledgeTerms: boolean }
  | { readonly kind: "poll"; readonly instance: string; readonly attemptId: string };

export interface ProviderDeviceSignInAnswer {
  readonly status: number;
  readonly body: unknown;
}

export interface ProviderDeviceSignInRuntime {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly fetch: typeof globalThis.fetch;
}

export class ProviderDeviceSignInFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderDeviceSignInFailure";
  }
}

const BEGIN_PATH = "/api/desktop/provider-sign-in/begin";
const POLL_PATH = "/api/desktop/provider-sign-in/poll";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNAVAILABLE = "Octant sign-in with a code is unavailable.";
const INVALID: ProviderDeviceSignInAnswer = {
  status: 400,
  body: { category: "invalid", message: "The sign-in request is invalid." },
};

/**
 * Sends one begin or poll to the host with the window's capability and the
 * desktop secret. A request of any other shape is refused here, before the
 * host sees it; a refusal from the host is an answer with its status. Only a
 * request that never reached the host throws.
 */
export async function sendProviderDeviceSignInRequest(
  runtime: ProviderDeviceSignInRuntime,
  request: unknown,
): Promise<ProviderDeviceSignInAnswer> {
  const route = routeFor(request);
  if (route === undefined) return INVALID;
  let response: Response;
  try {
    response = await runtime.fetch(new URL(route.path, runtime.serverUrl), {
      method: "POST",
      redirect: "error",
      headers: {
        "x-octant-desktop-secret": runtime.desktopBridgeSecret,
        "x-octant-window-capability": runtime.windowCapability,
        "content-type": "application/json",
      },
      body: JSON.stringify(route.body),
    });
  } catch {
    throw new ProviderDeviceSignInFailure(UNAVAILABLE);
  }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function routeFor(
  request: unknown,
): { readonly path: string; readonly body: Readonly<Record<string, unknown>> } | undefined {
  if (!isRecord(request)) return undefined;
  const { instance } = request;
  if (typeof instance !== "string" || instance.length === 0 || instance.length > 256) {
    return undefined;
  }
  const keys = Object.keys(request).sort().join(",");
  if (request.kind === "begin") {
    if (keys !== "acknowledgeTerms,instance,kind") return undefined;
    if (typeof request.acknowledgeTerms !== "boolean") return undefined;
    return { path: BEGIN_PATH, body: { instance, acknowledgeTerms: request.acknowledgeTerms } };
  }
  if (request.kind === "poll") {
    const { attemptId } = request;
    if (keys !== "attemptId,instance,kind") return undefined;
    if (typeof attemptId !== "string" || !UUID_PATTERN.test(attemptId)) return undefined;
    return { path: POLL_PATH, body: { instance, attemptId } };
  }
  return undefined;
}

export function installProviderDeviceSignInIpcHandlers(options: {
  readonly handle: (
    channel: string,
    handler: (event: unknown, ...args: readonly unknown[]) => unknown,
  ) => void;
  readonly runtimeFor: (event: unknown) => ProviderDeviceSignInRuntime;
}): void {
  options.handle(IPC_CHANNELS.providerDeviceSignIn, async (event, request) => {
    let runtime: ProviderDeviceSignInRuntime;
    try {
      runtime = options.runtimeFor(event);
    } catch {
      throw new Error("Octant rejected an unauthorized sign-in request.");
    }
    try {
      return await sendProviderDeviceSignInRequest(runtime, request);
    } catch (error) {
      throw new Error(error instanceof ProviderDeviceSignInFailure ? error.message : UNAVAILABLE);
    }
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
