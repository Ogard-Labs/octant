// Direct push delivery from any Octant host to Apple (APNs) and Google (FCM)
// using the signing account's own credentials.
//
// Only `CheckedPushMessageV2` (branded by the domain push builder after the
// host-side secret check) is accepted. No gateway or third-party push service
// is ever contacted: the only origins this module reaches are APNs (production
// or sandbox), Google's OAuth token service, and FCM v1. None is read from a
// credential file or a request. Redirects are refused and every call has a
// 10-second timeout.

import { createPrivateKey, sign } from "node:crypto";
import { connect, constants as http2Constants } from "node:http2";
import type {
  HubDirectPushEnvironment,
  LiveStatusV1,
  PushAlertV2,
  RemotePushPlatform,
} from "@octant/contracts";
import type { CheckedPushMessageV2 } from "@octant/domain/push-notification-policy";

/** The only hosts a direct send reaches. */
export const DIRECT_PUSH_ORIGINS = {
  apnsProduction: "https://api.push.apple.com",
  apnsDevelopment: "https://api.sandbox.push.apple.com",
  googleTokenService: "https://oauth2.googleapis.com",
  fcm: "https://fcm.googleapis.com",
} as const;

const SEND_TIMEOUT_MS = 10_000;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** Apple refuses a provider token older than an hour and a new one more often than every twenty minutes. */
const APNS_TOKEN_LIFETIME_MS = 45 * 60_000;
const LIVE_ACTIVITY_WIDGET_NAME = "AgentActivity";

export interface AppleCredential {
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  /** PKCS #8 PEM of the `.p8` key. */
  readonly privateKey: string;
}

export interface GoogleCredential {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly projectId: string;
}

/** The platform credentials this host holds; undefined when it holds none. Read before every send. */
export interface DirectPushCredentialSource {
  readonly apple: () => Promise<AppleCredential | undefined>;
  readonly google: () => Promise<GoogleCredential | undefined>;
}

export type DirectPushSendOutcome =
  /** The platform accepted the notification. */
  | "accepted"
  /** The platform refused the token as gone: the app was removed or the token replaced. */
  | "destination-gone"
  /** The platform did not take it, or could not be reached. */
  | "failed"
  /** This host holds no credential for that platform. */
  | "unavailable";

export interface DirectPushSendInput {
  readonly platform: RemotePushPlatform;
  /** The phone's APNs hex token or FCM registration token. */
  readonly token: string;
  readonly message: CheckedPushMessageV2;
}

export interface DirectPushSender {
  readonly send: (input: DirectPushSendInput) => Promise<DirectPushSendOutcome>;
}

export interface DirectPushSenderOptions {
  readonly credentials: DirectPushCredentialSource;
  readonly environment: () => HubDirectPushEnvironment;
  readonly now: () => number;
  /** Tests point these at local stand-ins; no setting or request can. */
  readonly origins?: Partial<Record<keyof typeof DIRECT_PUSH_ORIGINS, string>>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function buildApnsAlertRequest(
  credential: AppleCredential,
  jwt: string,
  alert: PushAlertV2,
): { readonly headers: Record<string, string>; readonly body: string } {
  const octant: Record<string, string | number> = {
    v: alert.version,
    kind: alert.kind,
    hostId: String(alert.hostId),
    ...(alert.threadId === undefined ? {} : { threadId: alert.threadId }),
    ...(alert.mode === undefined ? {} : { mode: alert.mode }),
  };
  return {
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": credential.bundleId,
      "apns-push-type": "alert",
      "apns-priority": alert.urgency === "high" ? "10" : "5",
      "apns-collapse-id": alert.collapseId,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        alert: { title: alert.title, body: alert.body },
        "thread-id": String(alert.hostId),
        "mutable-content": 1,
      },
      octant,
    }),
  };
}

function buildApnsLiveActivityRequest(
  credential: AppleCredential,
  jwt: string,
  liveStatus: LiveStatusV1,
): { readonly headers: Record<string, string>; readonly body: string } {
  const timestamp = Math.floor(Date.parse(liveStatus.occurredAt) / 1_000);
  const staleDate = Math.floor(Date.parse(liveStatus.staleAt) / 1_000);
  const contentState = {
    name: LIVE_ACTIVITY_WIDGET_NAME,
    props: {
      v: liveStatus.version,
      hostId: String(liveStatus.hostId),
      computerName: liveStatus.computerName,
      counts: liveStatus.counts,
      rows: liveStatus.rows,
      sequence: liveStatus.sequence,
      occurredAt: liveStatus.occurredAt,
      staleAt: liveStatus.staleAt,
    },
  };
  const aps: Record<string, unknown> = {
    timestamp,
    event: liveStatus.event,
    "content-state": contentState,
    ...(liveStatus.event === "end" ? { "dismissal-date": timestamp } : { "stale-date": staleDate }),
  };
  return {
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": `${credential.bundleId}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": liveStatus.urgency === "high" ? "10" : "5",
      "content-type": "application/json",
    },
    body: JSON.stringify({ aps }),
  };
}

function buildFcmAlertBody(token: string, alert: PushAlertV2): string {
  const data: Record<string, string> = {
    v: String(alert.version),
    kind: alert.kind,
    hostId: String(alert.hostId),
    ...(alert.threadId === undefined ? {} : { threadId: alert.threadId }),
    ...(alert.mode === undefined ? {} : { mode: alert.mode }),
    title: alert.title,
    body: alert.body,
  };
  return JSON.stringify({
    message: {
      token,
      data,
      android: {
        collapse_key: alert.collapseId,
        priority: alert.urgency === "high" ? "HIGH" : "NORMAL",
      },
    },
  });
}

function buildFcmLiveStatusBody(token: string, liveStatus: LiveStatusV1): string {
  // Android live-status messages carry no collapse_key: collapsible messages
  // are throttled by FCM to a burst of 20 then 1 per 3 minutes.
  return JSON.stringify({
    message: {
      token,
      data: {
        v: "2",
        type: "live-status",
        hostId: String(liveStatus.hostId),
        payload: JSON.stringify(liveStatus),
      },
      android: {
        priority: liveStatus.urgency === "high" ? "HIGH" : "NORMAL",
      },
    },
  });
}

export function createDirectPushSender(options: DirectPushSenderOptions): DirectPushSender {
  const origins = { ...DIRECT_PUSH_ORIGINS, ...options.origins };
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;
  let appleToken:
    | { readonly jwt: string; readonly madeAt: number; readonly keyId: string }
    | undefined;
  let googleToken:
    | { readonly accessToken: string; readonly expiresAt: number; readonly email: string }
    | undefined;

  const sendApple = async (input: DirectPushSendInput): Promise<DirectPushSendOutcome> => {
    const credential = await options.credentials.apple();
    if (credential === undefined) return "unavailable";
    // The token is a path segment: only what Apple issues (hexadecimal) may reach it.
    if (!/^[0-9a-fA-F]{1,512}$/.test(input.token)) return "destination-gone";
    const now = options.now();
    if (
      appleToken === undefined ||
      appleToken.keyId !== credential.keyId ||
      now - appleToken.madeAt >= APNS_TOKEN_LIFETIME_MS
    ) {
      const jwt = appleProviderToken(credential, now);
      if (jwt === undefined) return "failed";
      appleToken = { jwt, madeAt: now, keyId: credential.keyId };
    }
    const origin =
      options.environment() === "development" ? origins.apnsDevelopment : origins.apnsProduction;
    const built =
      input.message.type === "alert"
        ? buildApnsAlertRequest(credential, appleToken.jwt, input.message.alert)
        : buildApnsLiveActivityRequest(credential, appleToken.jwt, input.message.liveStatus);
    const answer = await appleRequest({
      origin,
      path: `/3/device/${input.token.toLowerCase()}`,
      headers: built.headers,
      body: built.body,
      timeoutMs,
    });
    if (answer === undefined) return "failed";
    if (answer.status === 200) return "accepted";
    if (answer.status === 403) appleToken = undefined;
    // Only 410 means the phone unregistered. APNs also answers 400 BadDeviceToken for a
    // development token sent to production; clearing the registration then would outlive
    // fixing the environment setting.
    if (answer.status === 410) return "destination-gone";
    return "failed";
  };

  const googleAccessToken = async (credential: GoogleCredential): Promise<string | undefined> => {
    const now = options.now();
    if (
      googleToken !== undefined &&
      googleToken.email === credential.clientEmail &&
      googleToken.expiresAt - 60_000 > now
    ) {
      return googleToken.accessToken;
    }
    const assertion = signedJwt(
      "RS256",
      { alg: "RS256", typ: "JWT" },
      {
        iss: credential.clientEmail,
        scope: FCM_SCOPE,
        aud: `${DIRECT_PUSH_ORIGINS.googleTokenService}/token`,
        iat: Math.floor(now / 1_000),
        exp: Math.floor(now / 1_000) + 3_600,
      },
      credential.privateKey,
    );
    if (assertion === undefined) return undefined;
    try {
      const response = await fetchImpl(`${origins.googleTokenService}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return undefined;
      const answer: unknown = await response.json();
      if (typeof answer !== "object" || answer === null) return undefined;
      const accessToken = "access_token" in answer ? answer.access_token : undefined;
      const lifetime = "expires_in" in answer ? answer.expires_in : undefined;
      if (typeof accessToken !== "string" || accessToken === "") return undefined;
      googleToken = {
        accessToken,
        email: credential.clientEmail,
        expiresAt: now + (typeof lifetime === "number" ? lifetime * 1_000 : 3_000_000),
      };
      return accessToken;
    } catch {
      return undefined;
    }
  };

  const sendGoogle = async (input: DirectPushSendInput): Promise<DirectPushSendOutcome> => {
    const credential = await options.credentials.google();
    if (credential === undefined) return "unavailable";
    const accessToken = await googleAccessToken(credential);
    if (accessToken === undefined) return "failed";
    const body =
      input.message.type === "alert"
        ? buildFcmAlertBody(input.token, input.message.alert)
        : buildFcmLiveStatusBody(input.token, input.message.liveStatus);
    try {
      const response = await fetchImpl(
        `${origins.fcm}/v1/projects/${credential.projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (response.status === 200) return "accepted";
      if (response.status === 401) googleToken = undefined;
      // 404 is FCM's answer for a registration token that is no longer valid.
      return response.status === 404 ? "destination-gone" : "failed";
    } catch {
      return "failed";
    }
  };

  return {
    send: (input) => (input.platform === "ios" ? sendApple(input) : sendGoogle(input)),
  };
}

/** A parsed credential file, or undefined when it is not one this code can sign with. */
export function parseAppleCredential(stored: string): AppleCredential | undefined {
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null) return undefined;
    const { keyId, teamId, bundleId, privateKey } = value as Record<string, unknown>;
    if (
      typeof keyId !== "string" ||
      typeof teamId !== "string" ||
      typeof bundleId !== "string" ||
      typeof privateKey !== "string"
    ) {
      return undefined;
    }
    return { keyId, teamId, bundleId, privateKey };
  } catch {
    return undefined;
  }
}

export function parseGoogleCredential(stored: string): GoogleCredential | undefined {
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null) return undefined;
    const { clientEmail, privateKey, projectId } = value as Record<string, unknown>;
    if (
      typeof clientEmail !== "string" ||
      typeof privateKey !== "string" ||
      typeof projectId !== "string"
    ) {
      return undefined;
    }
    return { clientEmail, privateKey, projectId };
  } catch {
    return undefined;
  }
}

/**
 * The record a service-account file becomes: only the fields signing needs.
 * The file's own token address is dropped, so the OAuth host stays fixed.
 */
export function googleCredentialFromServiceAccount(text: string): GoogleCredential | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const clientEmail = record["client_email"];
    const privateKey = record["private_key"];
    const projectId = record["project_id"];
    if (
      typeof clientEmail !== "string" ||
      typeof privateKey !== "string" ||
      typeof projectId !== "string" ||
      !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(clientEmail) ||
      !/^[a-z][a-z0-9-]{3,62}$/.test(projectId)
    ) {
      return undefined;
    }
    const key = createPrivateKey({ key: privateKey, format: "pem" });
    if (key.asymmetricKeyType !== "rsa") return undefined;
    return { clientEmail, privateKey, projectId };
  } catch {
    return undefined;
  }
}

/** True when the text is a P-256 PKCS #8 private key, the kind Apple issues. */
export function isAppleSigningKey(pem: string): boolean {
  try {
    const key = createPrivateKey({ key: pem, format: "pem" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

function appleProviderToken(credential: AppleCredential, now: number): string | undefined {
  return signedJwt(
    "ES256",
    { alg: "ES256", kid: credential.keyId },
    { iss: credential.teamId, iat: Math.floor(now / 1_000) },
    credential.privateKey,
  );
}

function signedJwt(
  algorithm: "ES256" | "RS256",
  header: Record<string, string>,
  claims: Record<string, string | number>,
  privateKey: string,
): string | undefined {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(claims)}`;
  try {
    const data = Buffer.from(signingInput, "utf8");
    const signature =
      algorithm === "ES256"
        ? sign("sha256", data, { key: privateKey, dsaEncoding: "ieee-p1363" })
        : sign("sha256", data, privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  } catch {
    return undefined;
  }
}

/** One HTTP/2 request to Apple, answered by its status and the reason word it gives; undefined when it never answered. */
function appleRequest(input: {
  readonly origin: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly timeoutMs: number;
}): Promise<{ readonly status: number; readonly reason?: string } | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const session = connect(input.origin);
    const finish = (value: { readonly status: number; readonly reason?: string } | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), input.timeoutMs);
    session.on("error", () => finish(undefined));
    const request = session.request({
      [http2Constants.HTTP2_HEADER_METHOD]: "POST",
      [http2Constants.HTTP2_HEADER_PATH]: input.path,
      ...input.headers,
    });
    let status = 0;
    const chunks: Array<Buffer> = [];
    request.on("response", (headers) => {
      status = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
    });
    request.on("data", (chunk: Buffer) => {
      if (chunks.length < 16) chunks.push(chunk);
    });
    request.on("error", () => finish(undefined));
    request.on("end", () => {
      let reason: string | undefined;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
          reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
        }
      } catch {
        // An empty or unreadable body is a success answer or a refusal without a reason.
      }
      finish(status === 0 ? undefined : { status, ...(reason === undefined ? {} : { reason }) });
    });
    request.end(input.body);
  });
}
