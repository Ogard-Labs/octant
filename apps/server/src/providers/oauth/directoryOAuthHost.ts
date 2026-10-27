import type {
  DirectoryOAuthHost,
  DirectoryOAuthSignInAgainReason,
} from "@octant/provider-sdk/directory-oauth";
import type { HostOAuthBrokerPort } from "./hostOAuthBrokerClient";

/**
 * The broker as a directory driver reaches it. `access` always names the
 * binding, so the broker releases a directory grant's token only to the
 * tenant (or the organization's own issuer), client, resource, and endpoint
 * it was signed in for. An answer
 * outside these shapes reads `unavailable`, which fails closed. Tokens are
 * returned to the caller and never logged.
 */
export function directoryOAuthHostFromBroker(
  broker: Pick<HostOAuthBrokerPort, "access" | "refresh">,
): DirectoryOAuthHost {
  return {
    refresh: async (credentialRef) => {
      const raw = await broker.refresh(credentialRef);
      if (!isRecord(raw) || typeof raw.kind !== "string") return { kind: "unavailable" };
      if (raw.kind === "refreshed" || raw.kind === "transient" || raw.kind === "unavailable") {
        return { kind: raw.kind };
      }
      const reason = raw.kind === "sign-in-again" ? signInAgainReason(raw.reason) : undefined;
      return reason === undefined ? { kind: "unavailable" } : { kind: "sign-in-again", reason };
    },
    access: async (credentialRef, binding) => {
      const raw = await broker.access(
        credentialRef,
        "tenantId" in binding
          ? {
              tenantId: String(binding.tenantId),
              clientId: String(binding.clientId),
              audience: binding.audience,
              endpointOrigin: binding.endpointOrigin,
            }
          : {
              issuer: String(binding.issuer),
              clientId: String(binding.clientId),
              scope: String(binding.scope),
              endpointOrigin: binding.endpointOrigin,
            },
      );
      if (!isRecord(raw) || typeof raw.kind !== "string") return { kind: "unavailable" };
      if (raw.kind === "binding-mismatch") return { kind: "binding-mismatch" };
      if (raw.kind === "sign-in-again") {
        const reason = signInAgainReason(raw.reason);
        return reason === undefined ? { kind: "unavailable" } : { kind: "sign-in-again", reason };
      }
      // A directory token always expires; one without an expiry is not one.
      if (
        raw.kind !== "granted" ||
        typeof raw.accessToken !== "string" ||
        raw.accessToken.length === 0 ||
        typeof raw.expiresAt !== "string"
      ) {
        return { kind: "unavailable" };
      }
      return { kind: "granted", accessToken: raw.accessToken, expiresAt: raw.expiresAt };
    },
  };
}

function signInAgainReason(value: unknown): DirectoryOAuthSignInAgainReason | undefined {
  return value === "expired" ||
    value === "revoked" ||
    value === "refresh-reused" ||
    value === "interaction-required"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
