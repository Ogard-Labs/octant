import type { SubscriptionOAuthHost } from "@octant/provider-sdk/subscription-oauth";
import type { HostOAuthBrokerPort } from "./hostOAuthBrokerClient";

/** Map broker access and refresh into the driver host. Tokens are not logged. */
export function subscriptionOAuthHostFromBroker(
  broker: Pick<HostOAuthBrokerPort, "access" | "refresh">,
): SubscriptionOAuthHost {
  return {
    refresh: async (credentialRef) => {
      const raw = await broker.refresh(credentialRef);
      if (!isRecord(raw) || typeof raw.kind !== "string") return { kind: "unavailable" };
      if (raw.kind === "refreshed" || raw.kind === "transient" || raw.kind === "unavailable") {
        return { kind: raw.kind };
      }
      if (raw.kind !== "sign-in-again") return { kind: "unavailable" };
      if (raw.reason === "revoked" || raw.reason === "expired" || raw.reason === "refresh-reused") {
        return { kind: "sign-in-again", reason: raw.reason };
      }
      return { kind: "unavailable" };
    },
    access: async (credentialRef) => {
      const raw = await broker.access(credentialRef);
      if (!isRecord(raw) || typeof raw.kind !== "string") return { kind: "unavailable" };
      if (raw.kind === "unavailable") return { kind: "unavailable" };
      if (raw.kind === "sign-in-again") {
        if (
          raw.reason === "revoked" ||
          raw.reason === "expired" ||
          raw.reason === "refresh-reused"
        ) {
          return { kind: "sign-in-again", reason: raw.reason };
        }
        return { kind: "unavailable" };
      }
      if (
        raw.kind !== "granted" ||
        typeof raw.accessToken !== "string" ||
        raw.accessToken.length === 0 ||
        (raw.expiresAt !== undefined && typeof raw.expiresAt !== "string")
      ) {
        return { kind: "unavailable" };
      }
      return {
        kind: "granted",
        accessToken: raw.accessToken,
        ...(raw.expiresAt === undefined ? {} : { expiresAt: raw.expiresAt }),
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
