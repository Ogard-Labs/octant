/**
 * The server's handle on the host credential broker's linked-secret-store
 * routes. Every call answers with a value: a broker that is down, refuses, or
 * answers in an unexpected shape is `broker-unavailable`, never an exception
 * and never a guess. No answer carries what an item resolves to.
 */

import type { SecretStoreKind, SecretStoreToolState } from "@octant/contracts/secret-stores";

export type SecretStoreNamespace = "provider" | "mcp-server";
export type SecretStoreBrokerDown = { readonly status: "broker-unavailable" };

export type StoreCheckStatus =
  | "found"
  | "locked"
  | "missing"
  | "unavailable"
  | "not-linked"
  | "invalid-reference";

export interface BrokerStoreStatus {
  readonly kind: SecretStoreKind;
  readonly label: string;
  readonly linked: boolean;
  readonly linkedAt?: string;
  readonly tool: SecretStoreToolState;
}

export type PointStatus = Exclude<StoreCheckStatus, "found"> | "pointed" | "key-already-stored";

export type ReferenceAnswer =
  | { readonly status: "none" }
  | { readonly status: "linked"; readonly store: SecretStoreKind; readonly reference: string };

export interface SecretStoreBrokerClient {
  readonly status: () => Promise<
    | { readonly status: "ok"; readonly stores: ReadonlyArray<BrokerStoreStatus> }
    | SecretStoreBrokerDown
  >;
  readonly link: (
    store: SecretStoreKind,
  ) => Promise<
    | { readonly status: "linked" | "locked" | "not-installed" | "unavailable" }
    | SecretStoreBrokerDown
  >;
  readonly unlink: (
    store: SecretStoreKind,
  ) => Promise<{ readonly status: "unlinked" } | SecretStoreBrokerDown>;
  readonly check: (
    store: SecretStoreKind,
    reference: string,
  ) => Promise<{ readonly status: StoreCheckStatus } | SecretStoreBrokerDown>;
  readonly point: (input: {
    readonly namespace: SecretStoreNamespace;
    readonly id: string;
    readonly store: SecretStoreKind;
    readonly reference: string;
  }) => Promise<{ readonly status: PointStatus } | SecretStoreBrokerDown>;
  /** Puts a pointer back without reading its item, for undoing a change. */
  readonly restore: (input: {
    readonly namespace: SecretStoreNamespace;
    readonly id: string;
    readonly store: SecretStoreKind;
    readonly reference: string;
  }) => Promise<{ readonly status: PointStatus } | SecretStoreBrokerDown>;
  readonly reference: (input: {
    readonly namespace: SecretStoreNamespace;
    readonly id: string;
  }) => Promise<ReferenceAnswer | SecretStoreBrokerDown>;
  /** Removes a pointer; answers what it pointed at so the change can be journaled. */
  readonly clear: (input: {
    readonly namespace: SecretStoreNamespace;
    readonly id: string;
  }) => Promise<
    | { readonly status: "cleared"; readonly store: SecretStoreKind; readonly reference: string }
    | { readonly status: "none" }
    | SecretStoreBrokerDown
  >;
}

export interface SecretStoreBrokerClientOptions {
  readonly url: string;
  readonly token: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

const DOWN: SecretStoreBrokerDown = { status: "broker-unavailable" };
const CHECK_STATUSES: ReadonlyArray<string> = [
  "found",
  "locked",
  "missing",
  "unavailable",
  "not-linked",
  "invalid-reference",
];
const TOOL_STATES: ReadonlyArray<string> = ["ready", "locked", "not-installed", "unavailable"];

export function makeSecretStoreBrokerClient(
  options: SecretStoreBrokerClientOptions,
): SecretStoreBrokerClient {
  const fetchPort = options.fetch ?? globalThis.fetch;
  const post = async (
    operation: string,
    body: object,
  ): Promise<Record<string, unknown> | undefined> => {
    try {
      const response = await fetchPort(
        new URL(`/v1/secret-stores/${operation}`, options.url).toString(),
        {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "x-octant-credential-broker-token": options.token,
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) return undefined;
      const parsed: unknown = await response.json();
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const isKind = (value: unknown): value is SecretStoreKind => value === "onepassword";

  return {
    status: async () => {
      const answer = await post("status", {});
      const stores = answer?.stores;
      if (!Array.isArray(stores)) return DOWN;
      const decoded: BrokerStoreStatus[] = [];
      for (const entry of stores as ReadonlyArray<Record<string, unknown>>) {
        if (
          !isKind(entry.kind) ||
          typeof entry.label !== "string" ||
          typeof entry.linked !== "boolean" ||
          typeof entry.tool !== "string" ||
          !TOOL_STATES.includes(entry.tool)
        ) {
          return DOWN;
        }
        decoded.push({
          kind: entry.kind,
          label: entry.label,
          linked: entry.linked,
          ...(typeof entry.linkedAt === "string" ? { linkedAt: entry.linkedAt } : {}),
          tool: entry.tool as SecretStoreToolState,
        });
      }
      return { status: "ok", stores: decoded };
    },
    link: async (store) => {
      const answer = await post("link", { store });
      const status = answer?.status;
      return status === "linked" ||
        status === "locked" ||
        status === "not-installed" ||
        status === "unavailable"
        ? { status }
        : DOWN;
    },
    unlink: async (store) =>
      (await post("unlink", { store }))?.status === "unlinked" ? { status: "unlinked" } : DOWN,
    check: async (store, reference) => {
      const status = (await post("check", { store, reference }))?.status;
      return typeof status === "string" && CHECK_STATUSES.includes(status)
        ? { status: status as StoreCheckStatus }
        : DOWN;
    },
    point: async ({ namespace, id, store, reference }) => {
      const status = (await post("point", { namespace, id, store, reference }))?.status;
      return typeof status === "string" &&
        (status === "pointed" ||
          status === "key-already-stored" ||
          (CHECK_STATUSES.includes(status) && status !== "found"))
        ? { status: status as PointStatus }
        : DOWN;
    },
    restore: async ({ namespace, id, store, reference }) => {
      const status = (await post("restore", { namespace, id, store, reference }))?.status;
      return status === "pointed" ||
        status === "key-already-stored" ||
        status === "not-linked" ||
        status === "invalid-reference"
        ? { status }
        : DOWN;
    },
    reference: async ({ namespace, id }) => {
      const answer = await post("reference", { namespace, id });
      if (answer?.status === "none") return { status: "none" };
      if (
        answer?.status === "linked" &&
        isKind(answer.store) &&
        typeof answer.reference === "string"
      ) {
        return { status: "linked", store: answer.store, reference: answer.reference };
      }
      return DOWN;
    },
    clear: async ({ namespace, id }) => {
      const answer = await post("clear", { namespace, id });
      if (answer?.status === "none") return { status: "none" };
      if (
        answer?.status === "cleared" &&
        isKind(answer.store) &&
        typeof answer.reference === "string"
      ) {
        return { status: "cleared", store: answer.store, reference: answer.reference };
      }
      return DOWN;
    },
  };
}
