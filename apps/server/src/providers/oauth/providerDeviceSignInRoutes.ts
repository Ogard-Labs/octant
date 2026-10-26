// Host-local organization sign-in with a device code, for a host without the
// desktop app.
//
// The desktop and a browser sign an Azure AI Foundry endpoint in on a loopback
// redirect, which a person at another device cannot reach. A headless host's
// owner runs `octant provider sign-in <instance>` instead, and these routes
// begin a device-code sign-in for an instance the person opted in. They take
// the same callers the provider key routes take, and only those: a process
// holding the desktop bridge secret, with no `Origin` header, on a loopback
// address, under a registered window capability. The private listener never
// forwards `/api/desktop`, so a paired device cannot reach them, and a browser
// page on the host never holds the bridge secret. A device code is never shown
// to Settings or any browser: the flow is the easier one to phish, so it
// begins only where the person typed the command.
//
// Once a code is issued the server follows the attempt itself until the
// directory answers, so a sign-in the person finishes after the command
// stopped waiting still stores its pointer, and one whose instance was removed
// meanwhile is forgotten, instead of leaving a grant in the broker that
// nothing names.

import type { ProviderInstance, ProviderInstanceId } from "@octant/contracts";
import type { HostOAuthDescriptor } from "@octant/contracts/host-oauth";
import { AZURE_FOUNDRY_DIRECTORY_SIGN_IN, azureFoundryDirectoryDescriptor } from "@octant/domain";
import { isLoopbackHostname } from "../../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../../windowAuthorityStore";
import { resolveInstance, secretsEqual } from "../providerCredentialRoutes";
import { dispatchDirectorySignIn } from "./providerDirectorySignIn";
import type {
  ProviderOAuthCommand,
  ProviderOAuthRouteDependencies,
  ProviderOAuthView,
} from "./providerOAuthRoutes";

const ROUTES = {
  begin: "/api/desktop/provider-sign-in/begin",
  poll: "/api/desktop/provider-sign-in/poll",
} as const;

type Route = (typeof ROUTES)[keyof typeof ROUTES];

const MAX_BODY_BYTES = 4 * 1_024;
const MAX_INSTANCE_REFERENCE_LENGTH = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The broker polls the directory at the interval the directory names; the
// server only reads the broker's answer, so a short step costs one loopback
// request and lets the command report a finished sign-in promptly.
const DEFAULT_FOLLOW_INTERVAL_MS = 2_000;
// The broker ends an attempt when its code expires; past that, plus this
// margin, the server stops following an attempt the broker never settled.
const FOLLOW_GRACE_MS = 60_000;
// A settled attempt stays readable this long, so a command that polls a
// little late still learns how its sign-in ended.
const SETTLED_RETENTION_MS = 5 * 60_000;

export type ProviderDeviceSignInRefusal =
  | "unauthorized"
  | "invalid"
  | "not-found"
  | "ambiguous"
  | "no-organization-sign-in"
  | "device-code-not-enabled"
  | "unknown-attempt"
  | "sign-in-refused"
  | "sign-in-unavailable";

const REFUSAL_STATUS: Readonly<Record<ProviderDeviceSignInRefusal, number>> = {
  unauthorized: 401,
  invalid: 400,
  "not-found": 404,
  ambiguous: 409,
  "no-organization-sign-in": 409,
  "device-code-not-enabled": 409,
  "unknown-attempt": 404,
  "sign-in-refused": 409,
  "sign-in-unavailable": 503,
};

const REFUSAL_MESSAGE: Readonly<Record<ProviderDeviceSignInRefusal, string>> = {
  unauthorized: "Device-code sign-in can be started only by the host-local octant command.",
  invalid: "The sign-in request is invalid.",
  "not-found": "No provider has that id or name.",
  ambiguous: "More than one provider has that name.",
  "no-organization-sign-in": "That provider does not sign in with an organization account.",
  "device-code-not-enabled": "That provider does not allow signing in with a device code.",
  "unknown-attempt": "This command did not start that sign-in, or it ended long ago.",
  "sign-in-refused": "The sign-in did not finish.",
  "sign-in-unavailable": "The host credential broker is unavailable.",
};

export interface ProviderDeviceSignInRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly readProviderInstances: () => ReadonlyArray<ProviderInstance>;
  /**
   * The organization sign-in's own dependencies, shared with Settings' route;
   * undefined when the server started without a credential broker.
   */
  readonly signIn: ProviderOAuthRouteDependencies | undefined;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly followIntervalMs?: number;
}

interface FollowedAttempt {
  readonly attemptId: string;
  readonly windowId: string;
  readonly instanceId: ProviderInstanceId;
  /** The descriptor the attempt began with, kept so it can be followed to its end. */
  readonly descriptor: HostOAuthDescriptor;
  readonly expiresAt: number;
  view: ProviderOAuthView;
  settledAt: number | undefined;
}

export function createProviderDeviceSignInRouteHandler(
  options: ProviderDeviceSignInRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const followIntervalMs = options.followIntervalMs ?? DEFAULT_FOLLOW_INTERVAL_MS;
  const attempts = new Map<string, FollowedAttempt>();

  const prune = (): void => {
    for (const [attemptId, attempt] of attempts) {
      const settledLongAgo =
        attempt.settledAt !== undefined && now() - attempt.settledAt > SETTLED_RETENTION_MS;
      if (settledLongAgo || now() > attempt.expiresAt + FOLLOW_GRACE_MS + SETTLED_RETENTION_MS) {
        attempts.delete(attemptId);
      }
    }
  };

  const follow = async (
    attempt: FollowedAttempt,
    dependencies: ProviderOAuthRouteDependencies,
  ): Promise<void> => {
    const command: ProviderOAuthCommand = {
      kind: "poll",
      instanceId: attempt.instanceId,
      descriptorId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId,
      attemptId: attempt.attemptId,
      flow: "device-code",
    };
    while (attempt.view.kind === "awaiting-consent") {
      await sleep(followIntervalMs);
      if (now() > attempt.expiresAt + FOLLOW_GRACE_MS) {
        attempt.view = { kind: "refused", reason: "timeout" };
        break;
      }
      // The broker's own answer first, from the descriptor the attempt began
      // with: it settles the attempt even if the instance is gone by then.
      const state = await dependencies.service.status({
        principalKind: "local-window",
        attemptId: attempt.attemptId,
        descriptor: attempt.descriptor,
      });
      if (state.kind === "awaiting-consent") continue;
      try {
        attempt.view = await dispatchDirectorySignIn({
          dependencies,
          command,
          principal: "local-window",
          actorId: attempt.windowId,
        });
      } catch {
        // Storing the pointer failed after the directory finished; the
        // command reports it, and the line below keeps it findable without
        // the error, which may echo data.
        console.warn("[host-oauth] a device-code sign-in finished but could not be stored.");
        attempt.view = { kind: "refused", reason: "unavailable" };
      }
      // The instance was removed, or stopped signing in with its
      // organization, while the person signed in, or its pointer could not
      // be stored: nothing names the new grant, so the broker forgets it.
      if (state.kind === "signed-in" && attempt.view.kind !== "signed-in") {
        await dependencies.service
          .signOut({
            principalKind: "local-window",
            descriptor: attempt.descriptor,
            credentialRef: state.credentialRef,
            forgetWhenNotRevoked: true,
          })
          .catch(() => undefined);
      }
    }
    attempt.settledAt = now();
  };

  return async (request) => {
    const url = new URL(request.url);
    if (!Object.values(ROUTES).includes(url.pathname as Route)) return undefined;
    const route = url.pathname as Route;
    if (
      options.desktopBridgeSecret === undefined ||
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !secretsEqual(
        options.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
    ) {
      return refuse("unauthorized");
    }
    let windowId: string;
    try {
      windowId = String(
        options.windowAuthorityStore.authenticate(
          request.headers.get("x-octant-window-capability") ?? "",
          now(),
        ),
      );
    } catch (error) {
      if (error instanceof WindowAuthorityError) return refuse("unauthorized");
      throw error;
    }
    if (request.method !== "POST" || url.search !== "") return refuse("invalid");
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return refuse("invalid");
    }
    const body = await readJson(request);
    if (body === undefined) return refuse("invalid");
    const decoded = decodeRequest(route, body);
    if (decoded === undefined) return refuse("invalid");

    const target = resolveInstance(decoded.instance, options.readProviderInstances(), []);
    if (target.kind === "ambiguous") {
      return Response.json(
        {
          category: "ambiguous",
          message: REFUSAL_MESSAGE.ambiguous,
          candidates: target.candidates,
        },
        { status: REFUSAL_STATUS.ambiguous },
      );
    }
    if (target.kind !== "existing") return refuse("not-found");
    const { instance } = target;
    const named = { instanceId: String(instance.id), displayName: instance.displayName };
    prune();

    if (decoded.kind === "poll") {
      const attempt = attempts.get(decoded.attemptId);
      // An attempt answers only the command that began it, for its instance.
      if (
        attempt === undefined ||
        attempt.windowId !== windowId ||
        String(attempt.instanceId) !== String(instance.id)
      ) {
        return refuse("unknown-attempt");
      }
      return answerView(attempt.view, named);
    }

    if (
      instance.driverKind !== "azure-foundry" ||
      instance.configuration.authentication !== "directory-oauth"
    ) {
      return refuse("no-organization-sign-in");
    }
    if (instance.configuration.deviceCodeSignIn !== true) {
      return refuse("device-code-not-enabled");
    }
    const dependencies = options.signIn;
    if (dependencies === undefined) return refuse("sign-in-unavailable");
    // The same descriptor the shared sign-in path builds from the instance;
    // the follower keeps it to read the broker's answer to the end.
    const descriptor = azureFoundryDirectoryDescriptor(instance.configuration, "device-code");
    if (descriptor === undefined) {
      return answerView({ kind: "refused", reason: "endpoint-mismatch" }, named);
    }
    const command = (kind: ProviderOAuthCommand["kind"]): ProviderOAuthCommand => ({
      kind,
      instanceId: instance.id,
      descriptorId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId,
      attemptId: "",
      flow: "device-code",
    });
    try {
      if (decoded.acknowledgeTerms) {
        const acknowledged = await dispatchDirectorySignIn({
          dependencies,
          command: command("acknowledge"),
          principal: "local-window",
          actorId: windowId,
        });
        if (acknowledged.kind === "refused") return answerView(acknowledged, named);
      }
      const view = await dispatchDirectorySignIn({
        dependencies,
        command: command("begin"),
        principal: "local-window",
        actorId: windowId,
      });
      if (view.kind === "refused" && view.reason === "terms-required") {
        return Response.json({
          outcome: "terms-required",
          ...named,
          termsSummary: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.termsSummary,
        });
      }
      if (view.kind !== "awaiting-consent" || view.flow !== "device-code") {
        return answerView(view, named);
      }
      const attempt: FollowedAttempt = {
        attemptId: view.attemptId,
        windowId,
        instanceId: instance.id,
        descriptor,
        expiresAt: Date.parse(view.expiresAt),
        view,
        settledAt: undefined,
      };
      attempts.set(attempt.attemptId, attempt);
      void follow(attempt, dependencies);
      return Response.json({
        outcome: "awaiting-code",
        ...named,
        attemptId: view.attemptId,
        verificationUri: view.verificationUri,
        userCode: view.userCode,
        expiresAt: view.expiresAt,
        warning: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.deviceCodeWarning,
      });
    } catch {
      return refuse("sign-in-unavailable");
    }
  };
}

/** The command's answer for a sign-in view; never a token, a code, or a reference. */
function answerView(
  view: ProviderOAuthView,
  named: { readonly instanceId: string; readonly displayName: string },
): Response {
  if (view.kind === "awaiting-consent") return Response.json({ outcome: "waiting", ...named });
  if (view.kind === "signed-in") {
    return Response.json({ outcome: "signed-in", ...named, accountLabel: view.accountLabel });
  }
  if (view.kind === "refused") {
    if (view.reason === "unavailable") return refuse("sign-in-unavailable");
    if (view.reason === "device-code-not-enabled") return refuse("device-code-not-enabled");
    if (view.reason === "unsupported-driver") return refuse("no-organization-sign-in");
    return Response.json(
      {
        category: "sign-in-refused",
        message: REFUSAL_MESSAGE["sign-in-refused"],
        reason: /^[a-z][a-z0-9-]{0,63}$/.test(view.reason) ? view.reason : "refused",
      },
      { status: REFUSAL_STATUS["sign-in-refused"] },
    );
  }
  return Response.json(
    { category: "sign-in-refused", message: REFUSAL_MESSAGE["sign-in-refused"], reason: "ended" },
    { status: REFUSAL_STATUS["sign-in-refused"] },
  );
}

type DecodedRequest =
  | { readonly kind: "begin"; readonly instance: string; readonly acknowledgeTerms: boolean }
  | { readonly kind: "poll"; readonly instance: string; readonly attemptId: string };

function decodeRequest(route: Route, value: unknown): DecodedRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  const instance = record.instance;
  if (
    typeof instance !== "string" ||
    instance.length === 0 ||
    instance.length > MAX_INSTANCE_REFERENCE_LENGTH
  ) {
    return undefined;
  }
  if (route === ROUTES.begin) {
    if (keys !== "acknowledgeTerms,instance" || typeof record.acknowledgeTerms !== "boolean") {
      return undefined;
    }
    return { kind: "begin", instance, acknowledgeTerms: record.acknowledgeTerms };
  }
  const attemptId = record.attemptId;
  if (keys !== "attemptId,instance" || typeof attemptId !== "string") return undefined;
  if (!UUID_PATTERN.test(attemptId)) return undefined;
  return { kind: "poll", instance, attemptId };
}

function refuse(category: ProviderDeviceSignInRefusal): Response {
  return Response.json(
    { category, message: REFUSAL_MESSAGE[category] },
    { status: REFUSAL_STATUS[category] },
  );
}

async function readJson(request: Request): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
