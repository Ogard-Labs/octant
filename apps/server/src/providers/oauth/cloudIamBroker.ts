import type { CloudIamSignInDescriptor } from "@octant/domain";
import type {
  CloudIamHost,
  CloudIamRequest,
  CloudIamSignInAgainReason,
} from "@octant/provider-sdk/cloud-iam";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFUSED = "Octant credential broker refused the request.";

/**
 * The broker's cloud-IAM routes as the server reaches them. Every answer is
 * read by the caller as untrusted; nothing here answers with key material,
 * because no route has any to give.
 */
export interface CloudIamBrokerPort {
  readonly begin: (input: {
    readonly descriptor: CloudIamSignInDescriptor;
    readonly actorId: string;
    readonly termsAcknowledgedAt: string;
  }) => Promise<unknown>;
  readonly status: (attemptId: string) => Promise<unknown>;
  readonly sign: (
    credentialRef: string,
    request: CloudIamRequest,
    renewCredentials: boolean,
  ) => Promise<unknown>;
  /** Sign out: the broker asks the portal to end the session and deletes the grant. */
  readonly revoke: (credentialRef: string) => Promise<unknown>;
}

export function makeCloudIamBrokerClient(options: {
  readonly url: string;
  readonly token: string;
  /** A call signature, not `typeof fetch`: a test double need not carry Bun's extras. */
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): CloudIamBrokerPort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchImpl(new URL(path, options.url), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-octant-credential-broker-token": options.token,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(REFUSED);
    const value: unknown = await response.json();
    return value;
  };
  const reference = (value: string): void => {
    if (!UUID_PATTERN.test(value)) throw new Error(REFUSED);
  };
  return {
    begin: async (input) => {
      reference(input.actorId);
      const { descriptor } = input;
      return post("/v1/cloud-iam/begin", {
        actorId: input.actorId,
        termsAcknowledgedAt: input.termsAcknowledgedAt,
        descriptor: {
          descriptorId: descriptor.descriptorId,
          termsId: descriptor.termsId,
          flow: descriptor.flow,
          source: {
            startUrl: String(descriptor.source.startUrl),
            ssoRegion: String(descriptor.source.ssoRegion),
            accountId: String(descriptor.source.accountId),
            roleName: String(descriptor.source.roleName),
          },
          scope: {
            partition: descriptor.scope.partition,
            region: String(descriptor.scope.region),
            service: descriptor.scope.service,
            host: descriptor.scope.host,
            pathPrefix: descriptor.scope.pathPrefix,
            method: descriptor.scope.method,
          },
        },
      });
    },
    status: async (attemptId) => {
      reference(attemptId);
      return post("/v1/cloud-iam/status", { attemptId });
    },
    sign: async (credentialRef, request, renewCredentials) => {
      reference(credentialRef);
      // Exactly the request's own fields: the broker refuses a body that
      // brings anything else, a digest or a scope of the caller's own.
      return post("/v1/cloud-iam/sign", {
        credentialRef,
        request: {
          method: request.method,
          host: request.host,
          path: request.path,
          query: request.query.map(([key, value]) => [key, value]),
          headers: { ...request.headers },
          payloadHash: request.payloadHash,
        },
        ...(renewCredentials ? { renewCredentials: true } : {}),
      });
    },
    revoke: async (credentialRef) => {
      reference(credentialRef);
      return post("/v1/cloud-iam/revoke", { credentialRef });
    },
  };
}

/**
 * The broker as a Bedrock driver reaches it. An answer outside these shapes
 * reads `unavailable`, which fails closed; signature headers are returned to
 * the caller for one request and never logged.
 */
export function cloudIamHostFromBroker(broker: Pick<CloudIamBrokerPort, "sign">): CloudIamHost {
  return {
    sign: async (credentialRef, request, options) => {
      const raw = await broker.sign(credentialRef, request, options.renewCredentials);
      if (!isRecord(raw) || typeof raw.kind !== "string") return { kind: "unavailable" };
      if (raw.kind === "outside-scope" || raw.kind === "not-authorized") return { kind: raw.kind };
      if (raw.kind === "sign-in-again") {
        const reason = signInAgainReason(raw.reason);
        return reason === undefined ? { kind: "unavailable" } : { kind: "sign-in-again", reason };
      }
      if (raw.kind !== "signed" || !isRecord(raw.headers)) return { kind: "unavailable" };
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(raw.headers)) {
        if (typeof value !== "string") return { kind: "unavailable" };
        headers[name] = value;
      }
      return { kind: "signed", headers };
    },
  };
}

function signInAgainReason(value: unknown): CloudIamSignInAgainReason | undefined {
  return value === "expired" || value === "revoked" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
