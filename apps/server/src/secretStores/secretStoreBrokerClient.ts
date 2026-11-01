/**
 * The server's handle on the host credential broker's linked-secret-store
 * routes. Every call answers with a value: a broker that is down, refuses, or
 * answers in an unexpected shape is `broker-unavailable`, never an exception
 * and never a guess. No answer carries what an item resolves to.
 */

import type {
  AwsCliKeyReference,
  SecretStoreKind,
  SecretStoreToolState,
} from "@octant/contracts/secret-stores";

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

export type AwsCliReferenceAnswer =
  | { readonly status: "none" }
  | { readonly status: "linked"; readonly pointer: AwsCliKeyReference };

/**
 * A short-lived AWS session for one command, or why there is none. The
 * long-lived key pair never reaches the server; only this session does.
 */
export type AwsCliSessionAnswer =
  | {
      readonly status: "issued";
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly sessionToken: string;
      readonly expiration: string;
    }
  | {
      readonly status:
        | "none"
        | "locked"
        | "missing"
        | "unavailable"
        | "not-linked"
        | "invalid-reference"
        | "refused";
    };

export interface SecretStoreBrokerClient {
  readonly awsCliReference: () => Promise<AwsCliReferenceAnswer | SecretStoreBrokerDown>;
  /** Points the AWS command line at two items, after the broker proved both resolve now. */
  readonly pointAwsCli: (
    pointer: AwsCliKeyReference,
  ) => Promise<
    { readonly status: Exclude<PointStatus, "key-already-stored"> } | SecretStoreBrokerDown
  >;
  /** Puts an earlier pointer back without reading its items, for undoing a change. */
  readonly restoreAwsCli: (
    pointer: AwsCliKeyReference,
  ) => Promise<
    { readonly status: "pointed" | "not-linked" | "invalid-reference" } | SecretStoreBrokerDown
  >;
  readonly clearAwsCli: () => Promise<
    | { readonly status: "cleared"; readonly pointer: AwsCliKeyReference }
    | { readonly status: "none" }
    | SecretStoreBrokerDown
  >;
  readonly awsCliSession: () => Promise<AwsCliSessionAnswer | SecretStoreBrokerDown>;
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
        new URL(
          operation.startsWith("/") ? operation : `/v1/secret-stores/${operation}`,
          options.url,
        ).toString(),
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
  const awsPointerOf = (answer: Record<string, unknown>): AwsCliKeyReference | undefined =>
    isKind(answer.store) &&
    typeof answer.accessKeyIdReference === "string" &&
    typeof answer.secretAccessKeyReference === "string"
      ? {
          store: answer.store,
          accessKeyIdReference: answer.accessKeyIdReference,
          secretAccessKeyReference: answer.secretAccessKeyReference,
        }
      : undefined;
  const AWS = "/v1/cloud-cli/aws/";

  return {
    awsCliReference: async () => {
      const answer = await post(`${AWS}reference`, {});
      if (answer?.status === "none") return { status: "none" };
      const pointer = answer?.status === "linked" ? awsPointerOf(answer) : undefined;
      return pointer === undefined ? DOWN : { status: "linked", pointer };
    },
    pointAwsCli: async (pointer) => {
      const status = (await post(`${AWS}point`, pointer))?.status;
      return typeof status === "string" &&
        (status === "pointed" || (CHECK_STATUSES.includes(status) && status !== "found"))
        ? { status: status as Exclude<PointStatus, "key-already-stored"> }
        : DOWN;
    },
    restoreAwsCli: async (pointer) => {
      const status = (await post(`${AWS}restore`, pointer))?.status;
      return status === "pointed" || status === "not-linked" || status === "invalid-reference"
        ? { status }
        : DOWN;
    },
    clearAwsCli: async () => {
      const answer = await post(`${AWS}clear`, {});
      if (answer?.status === "none") return { status: "none" };
      const pointer = answer?.status === "cleared" ? awsPointerOf(answer) : undefined;
      return pointer === undefined ? DOWN : { status: "cleared", pointer };
    },
    awsCliSession: async () => {
      const answer = await post(`${AWS}session`, {});
      const status = answer?.status;
      if (
        status === "issued" &&
        typeof answer?.accessKeyId === "string" &&
        typeof answer.secretAccessKey === "string" &&
        typeof answer.sessionToken === "string" &&
        typeof answer.expiration === "string"
      ) {
        return {
          status,
          accessKeyId: answer.accessKeyId,
          secretAccessKey: answer.secretAccessKey,
          sessionToken: answer.sessionToken,
          expiration: answer.expiration,
        };
      }
      return status === "none" ||
        status === "locked" ||
        status === "missing" ||
        status === "unavailable" ||
        status === "not-linked" ||
        status === "invalid-reference" ||
        status === "refused"
        ? { status }
        : DOWN;
    },
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
