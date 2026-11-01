import type { CredentialBrokerClientOptions } from "../providers/credentialBrokerClient";

/**
 * The SSH keys Octant keeps for registered servers, through the credential
 * broker's own routes for them. Canonical: docs/architecture.md § Octant
 * Shield (servers as built).
 *
 * The broker gives out only a key's public line and a signature over one
 * login request for that key, so this process never holds a private key.
 * Every answer the broker cannot give is `undefined`: a command then signs
 * in with nothing and the server refuses it.
 */
export interface ServerSshKeys {
  /** The key's public line, making the key the first time. */
  readonly ensure: (serverId: string) => Promise<string | undefined>;
  /** The key's public line, when the server has a key. */
  readonly publicKey: (serverId: string) => Promise<string | undefined>;
  /** The SSH signature blob over `data`, which the broker signs only as a login for this key. */
  readonly signLogin: (serverId: string, data: Buffer) => Promise<Buffer | undefined>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_LINE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function makeServerSshKeysBrokerClient(
  options: CredentialBrokerClientOptions,
): ServerSshKeys {
  const fetch = options.fetch ?? globalThis.fetch;
  const call = async (
    operation: "ensure" | "public" | "sign",
    body: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown> | undefined> => {
    if (!UUID_PATTERN.test(body.serverId ?? "")) return undefined;
    try {
      const response = await fetch(new URL(`/v1/ssh-keys/${operation}`, options.url).toString(), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": options.token,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) return undefined;
      const value: unknown = await response.json();
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const publicLineOf = (value: Record<string, unknown> | undefined) =>
    typeof value?.publicKey === "string" && PUBLIC_LINE.test(value.publicKey)
      ? value.publicKey
      : undefined;
  return {
    ensure: async (serverId) => publicLineOf(await call("ensure", { serverId })),
    publicKey: async (serverId) => publicLineOf(await call("public", { serverId })),
    signLogin: async (serverId, data) => {
      const value = await call("sign", { serverId, data: data.toString("base64") });
      return typeof value?.signature === "string" && BASE64.test(value.signature)
        ? Buffer.from(value.signature, "base64")
        : undefined;
    },
  };
}
