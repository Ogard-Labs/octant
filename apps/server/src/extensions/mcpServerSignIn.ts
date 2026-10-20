import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import type { McpServerSignInView } from "@octant/contracts/extension-rpc";
import type { HostOAuthDescriptor, HostOAuthSignInState } from "@octant/contracts/host-oauth";
import type { AgentPluginsMcpLaunchSpec } from "@octant/plugin-host/agent-plugins";
import type { HostOAuthService } from "../providers/oauth/hostOAuthService";

const TERMS_ID = "mcp-sign-in-terms-1";
const METADATA_BYTES = 64 * 1_024;
const REQUEST_TIMEOUT_MS = 10_000;

type PrincipalKind = "local-window" | "remote-device";

export interface McpServerSignInRecord {
  readonly credentialRef: string;
  readonly descriptor: HostOAuthDescriptor;
  readonly issuer: string;
}

interface PersistedSignIns {
  readonly schemaVersion: 1;
  readonly signIns: Readonly<Record<string, McpServerSignInRecord>>;
}

export interface McpServerSignInOptions {
  readonly statePath: string;
  readonly oauth: HostOAuthService;
  /** The broker's access route: the bearer for a stored grant, refreshed as needed. */
  readonly access: (credentialRef: string) => Promise<unknown>;
  /** The address the component's package names, or undefined for a command server. */
  readonly serverUrl: (extensionId: string, componentId: string) => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly actorId: string;
  readonly now?: () => Date;
  /** Picks the loopback port the callback will listen on; the default binds and releases a free one. */
  readonly pickPort?: () => Promise<number>;
}

type Discovered =
  | {
      readonly kind: "discovered";
      readonly resource: string;
      readonly issuer: string;
      readonly authorizationEndpoint: string;
      readonly tokenEndpoint: string;
      readonly registrationEndpoint: string | undefined;
      readonly scopes: ReadonlyArray<string>;
    }
  | { readonly kind: "no-sign-in-offered" }
  | { readonly kind: "issuer-unsupported"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Sign-in to a hosted MCP server, the way the MCP authorization flow lays it
 * out: the server answers a bare request with 401 and names its protected
 * resource metadata; that names the authorization server; the server's
 * metadata names the endpoints; Octant registers itself as a public client
 * there (RFC 7591), then runs the host's own PKCE flow with the server's
 * canonical address as the `resource`. The grant lives in the credential
 * broker; this service keeps only its reference, the descriptor that made it
 * and the issuer's name, so a refresh and a sign-out can find it again.
 */
export class McpServerSignIn {
  readonly #options: McpServerSignInOptions;
  readonly #fetch: typeof fetch;
  #signIns = new Map<string, McpServerSignInRecord>();
  readonly #attempts = new Map<
    string,
    {
      readonly attemptId: string;
      readonly discovered: Extract<Discovered, { kind: "discovered" }>;
      readonly descriptor: HostOAuthDescriptor;
    }
  >();
  #loaded = false;

  constructor(options: McpServerSignInOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async status(extensionId: string, componentId: string): Promise<McpServerSignInView> {
    await this.#load();
    const key = signInKey(extensionId, componentId);
    const pending = this.#attempts.get(key);
    if (pending !== undefined) {
      return this.#poll(key, pending.attemptId, "local-window");
    }
    const record = this.#signIns.get(key);
    if (record !== undefined) return { kind: "signed-in", issuer: record.issuer };
    const url = await this.#options.serverUrl(extensionId, componentId);
    if (url === undefined) return { kind: "not-applicable" };
    return { kind: "signed-out" };
  }

  async begin(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    await this.#load();
    if (principalKind !== "local-window") {
      return refused("local-host-required", "Sign in from the Octant window on this host.");
    }
    const key = signInKey(extensionId, componentId);
    const url = await this.#options.serverUrl(extensionId, componentId);
    if (url === undefined) return { kind: "not-applicable" };
    const discovered = await this.#discover(url);
    if (discovered.kind === "no-sign-in-offered") {
      return refused("no-sign-in-offered", "This server answered without asking for a sign-in.");
    }
    if (discovered.kind === "issuer-unsupported") {
      return refused("issuer-unsupported", discovered.message);
    }
    if (discovered.kind === "unavailable") return refused("unavailable", discovered.message);
    if (discovered.registrationEndpoint === undefined) {
      return refused(
        "client-registration-unavailable",
        "This server's sign-in needs a client id Octant cannot register for itself.",
      );
    }
    let port: number;
    try {
      port = await (this.#options.pickPort ?? pickFreePort)();
    } catch {
      return refused("unavailable", "No loopback port was free for the sign-in callback.");
    }
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const registered = await this.#register(
      discovered.registrationEndpoint,
      redirectUri,
      discovered.scopes,
    );
    if (registered.kind !== "registered") return refused("issuer-unsupported", registered.message);
    const descriptor: HostOAuthDescriptor = {
      descriptorId: `mcp-${digest(key)}` as HostOAuthDescriptor["descriptorId"],
      clientId: registered.clientId as HostOAuthDescriptor["clientId"],
      dialect: "mcp-authorization",
      flow: "authorization-code-pkce",
      authorizationEndpoint:
        discovered.authorizationEndpoint as HostOAuthDescriptor["authorizationEndpoint"],
      tokenEndpoint: discovered.tokenEndpoint as HostOAuthDescriptor["tokenEndpoint"],
      scopes: discovered.scopes as HostOAuthDescriptor["scopes"],
      termsId: TERMS_ID as HostOAuthDescriptor["termsId"],
      resource: discovered.resource as HostOAuthDescriptor["resource"],
      redirectPort: port,
    };
    // The person's click is the acknowledgment: there is no vendor terms text
    // for a server they added themselves, only the host's own notice.
    const acknowledged = this.#options.oauth.acknowledgeTerms({
      principalKind,
      actorId: this.#options.actorId,
      descriptor,
    });
    if (acknowledged.kind === "refused") return fromRefusal(acknowledged.reason);
    const state = await this.#options.oauth.begin({
      principalKind,
      actorId: this.#options.actorId,
      descriptor,
    });
    if (state.kind === "awaiting-consent" && state.flow === "authorization-code-pkce") {
      this.#attempts.set(key, { attemptId: state.attemptId, discovered, descriptor });
      return {
        kind: "awaiting-consent",
        attemptId: state.attemptId,
        authorizationUrl: state.authorizationUrl,
        expiresAt: state.expiresAt,
      };
    }
    return viewOf(state, discovered.issuer);
  }

  async poll(
    extensionId: string,
    componentId: string,
    attemptId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    await this.#load();
    return this.#poll(signInKey(extensionId, componentId), attemptId, principalKind);
  }

  async #poll(
    key: string,
    attemptId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    const pending = this.#attempts.get(key);
    if (pending === undefined || pending.attemptId !== attemptId) {
      const record = this.#signIns.get(key);
      return record === undefined
        ? { kind: "signed-out" }
        : { kind: "signed-in", issuer: record.issuer };
    }
    const state = await this.#options.oauth.status({
      principalKind,
      attemptId,
      descriptor: pending.descriptor,
    });
    if (state.kind === "signed-in") {
      this.#attempts.delete(key);
      this.#signIns.set(key, {
        credentialRef: state.credentialRef,
        descriptor: pending.descriptor,
        issuer: pending.discovered.issuer,
      });
      await this.#persist();
      return { kind: "signed-in", issuer: pending.discovered.issuer };
    }
    if (state.kind === "refused") this.#attempts.delete(key);
    if (state.kind === "awaiting-consent" && state.flow === "authorization-code-pkce") {
      return {
        kind: "awaiting-consent",
        attemptId: state.attemptId,
        authorizationUrl: state.authorizationUrl,
        expiresAt: state.expiresAt,
      };
    }
    return viewOf(state, pending.discovered.issuer);
  }

  async signOut(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    await this.#load();
    if (principalKind !== "local-window") {
      return refused("local-host-required", "Sign out from the Octant window on this host.");
    }
    const key = signInKey(extensionId, componentId);
    this.#attempts.delete(key);
    const record = this.#signIns.get(key);
    if (record === undefined) return { kind: "signed-out" };
    // The grant is revoked at the issuer where it can be and forgotten
    // locally either way; a stale local record would only ever attach a
    // dead bearer.
    await this.#options.oauth.signOut({
      principalKind,
      descriptor: record.descriptor,
      credentialRef: record.credentialRef,
      forgetWhenNotRevoked: true,
    });
    this.#signIns.delete(key);
    await this.#persist();
    return { kind: "signed-out" };
  }

  /** Forgets a package's sign-ins once it is uninstalled; the grants are revoked where possible. */
  async forgetPackage(extensionId: string): Promise<void> {
    await this.#load();
    for (const [key, record] of [...this.#signIns]) {
      if (!key.startsWith(`${extensionId}:`)) continue;
      await this.#options.oauth
        .signOut({
          principalKind: "local-window",
          descriptor: record.descriptor,
          credentialRef: record.credentialRef,
          forgetWhenNotRevoked: true,
        })
        .catch(() => undefined);
      this.#signIns.delete(key);
    }
    await this.#persist();
  }

  /**
   * Attaches the signed-in bearer to a launch, when there is one. A sign-in
   * whose grant the broker can no longer honour leaves the launch alone and
   * the server answers 401, which Settings shows as Sign in again.
   */
  async attachBearer(
    extensionId: string,
    componentId: string,
    launch: AgentPluginsMcpLaunchSpec,
  ): Promise<AgentPluginsMcpLaunchSpec> {
    await this.#load();
    if (launch.transport === "stdio") return launch;
    const record = this.#signIns.get(signInKey(extensionId, componentId));
    if (record === undefined) return launch;
    let answer: unknown;
    try {
      answer = await this.#options.access(record.credentialRef);
    } catch {
      return launch;
    }
    if (!isRecord(answer) || answer.kind !== "granted" || typeof answer.accessToken !== "string") {
      return launch;
    }
    const tokenType = typeof answer.tokenType === "string" ? answer.tokenType : "Bearer";
    return {
      ...launch,
      headers: { ...launch.headers, Authorization: `${tokenType} ${answer.accessToken}` },
    };
  }

  async #discover(serverUrl: string): Promise<Discovered> {
    let probe: Response;
    try {
      probe = await this.#request(serverUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "Octant", version: "1" },
          },
        }),
      });
    } catch {
      return { kind: "unavailable", message: "The server did not answer." };
    }
    await probe.body?.cancel().catch(() => undefined);
    if (probe.status !== 401) return { kind: "no-sign-in-offered" };
    const challenge = probe.headers.get("www-authenticate") ?? "";
    const named = /resource_metadata="([^"]+)"/i.exec(challenge)?.[1];
    const server = new URL(serverUrl);
    const candidates = [
      ...(named === undefined ? [] : [named]),
      `${server.origin}/.well-known/oauth-protected-resource${server.pathname === "/" ? "" : server.pathname}`,
      `${server.origin}/.well-known/oauth-protected-resource`,
    ];
    let metadata: Record<string, unknown> | undefined;
    for (const candidate of candidates) {
      metadata = await this.#json(candidate);
      if (metadata !== undefined) break;
    }
    if (metadata === undefined) {
      return {
        kind: "issuer-unsupported",
        message: "The server asked for a sign-in but published no resource metadata.",
      };
    }
    const issuers = Array.isArray(metadata.authorization_servers)
      ? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string")
      : [];
    const issuer = issuers[0];
    if (issuer === undefined || !isHttps(issuer)) {
      return {
        kind: "issuer-unsupported",
        message: "The server's metadata names no https authorization server.",
      };
    }
    const resource =
      typeof metadata.resource === "string" && isAbsoluteUrl(metadata.resource)
        ? metadata.resource
        : canonicalResource(serverUrl);
    const issuerUrl = new URL(issuer);
    const path = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
    let issuerMetadata: Record<string, unknown> | undefined;
    for (const candidate of [
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuerUrl.origin}/.well-known/openid-configuration${path}`,
      `${issuerUrl.origin}${path}/.well-known/openid-configuration`,
    ]) {
      issuerMetadata = await this.#json(candidate);
      if (issuerMetadata !== undefined) break;
    }
    const authorizationEndpoint = issuerMetadata?.authorization_endpoint;
    const tokenEndpoint = issuerMetadata?.token_endpoint;
    if (
      issuerMetadata === undefined ||
      typeof authorizationEndpoint !== "string" ||
      typeof tokenEndpoint !== "string" ||
      !isHttps(authorizationEndpoint) ||
      !isHttps(tokenEndpoint)
    ) {
      return {
        kind: "issuer-unsupported",
        message: "The authorization server published no usable metadata.",
      };
    }
    const methods = issuerMetadata.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes("S256")) {
      return {
        kind: "issuer-unsupported",
        message: "The authorization server does not support PKCE with S256.",
      };
    }
    const registration = issuerMetadata.registration_endpoint;
    const scopes = Array.isArray(metadata.scopes_supported)
      ? metadata.scopes_supported
          .filter((entry): entry is string => typeof entry === "string")
          .filter((entry) => /^[A-Za-z0-9._:-]{1,128}$/.test(entry))
          .slice(0, 16)
      : [];
    return {
      kind: "discovered",
      resource,
      issuer: issuerUrl.host,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint:
        typeof registration === "string" && isHttps(registration) ? registration : undefined,
      scopes,
    };
  }

  /** Registers Octant as a public client (RFC 7591); the issuer answers with the client id to use. */
  async #register(
    registrationEndpoint: string,
    redirectUri: string,
    scopes: ReadonlyArray<string>,
  ): Promise<{ kind: "registered"; clientId: string } | { kind: "refused"; message: string }> {
    let response: Response;
    try {
      response = await this.#request(registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "Octant",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          ...(scopes.length === 0 ? {} : { scope: scopes.join(" ") }),
        }),
      });
    } catch {
      return {
        kind: "refused",
        message: "The authorization server did not answer the registration.",
      };
    }
    const body = await readBoundedJson(response);
    const clientId = isRecord(body) ? body.client_id : undefined;
    if (
      !response.ok ||
      typeof clientId !== "string" ||
      !/^[A-Za-z0-9._:~@/-]{1,256}$/.test(clientId)
    ) {
      return { kind: "refused", message: "The authorization server refused to register Octant." };
    }
    return { kind: "registered", clientId };
  }

  async #json(url: string): Promise<Record<string, unknown> | undefined> {
    if (!isHttps(url) && !isLoopbackHttp(url)) return undefined;
    try {
      const response = await this.#request(url, { headers: { accept: "application/json" } });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const body = await readBoundedJson(response);
      return isRecord(body) ? body : undefined;
    } catch {
      return undefined;
    }
  }

  #request(url: string, init: RequestInit): Promise<Response> {
    return this.#fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.#options.statePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedSignIns;
      if (parsed.schemaVersion !== 1 || !isRecord(parsed.signIns)) return;
      for (const [key, record] of Object.entries(parsed.signIns)) {
        if (isRecord(record) && typeof record.credentialRef === "string") {
          this.#signIns.set(key, record as McpServerSignInRecord);
        }
      }
    } catch {
      // An unreadable file is an empty one; the grants it named stay in the broker until the person signs out.
    }
  }

  async #persist(): Promise<void> {
    const payload: PersistedSignIns = {
      schemaVersion: 1,
      signIns: Object.fromEntries(this.#signIns),
    };
    await mkdir(dirname(this.#options.statePath), { recursive: true, mode: 0o700 });
    await writeFile(this.#options.statePath, JSON.stringify(payload), { mode: 0o600 });
  }
}

function signInKey(extensionId: string, componentId: string): string {
  return `${extensionId}:${componentId}`;
}

function refused(
  reason: Extract<McpServerSignInView, { kind: "refused" }>["reason"],
  message: string,
): McpServerSignInView {
  return { kind: "refused", reason, message };
}

function fromRefusal(reason: string): McpServerSignInView {
  if (reason === "local-host-required") {
    return refused("local-host-required", "Sign in from the Octant window on this host.");
  }
  if (reason === "unavailable") return refused("unavailable", "Sign-in is unavailable right now.");
  return refused("invalid", "Sign-in could not start.");
}

function viewOf(state: HostOAuthSignInState, issuer: string): McpServerSignInView {
  switch (state.kind) {
    case "signed-in":
      return { kind: "signed-in", issuer };
    case "sign-in-again":
      return { kind: "sign-in-again", reason: state.reason };
    case "refused":
      if (state.reason === "denied") return refused("denied", "The sign-in was denied.");
      if (state.reason === "timeout")
        return refused("timeout", "The sign-in page was not completed in time.");
      if (state.reason === "unavailable")
        return refused("unavailable", "Sign-in is unavailable right now.");
      if (state.reason === "local-host-required") {
        return refused("local-host-required", "Sign in from the Octant window on this host.");
      }
      return refused("invalid", "The authorization server refused the sign-in.");
    case "awaiting-consent":
      return refused("invalid", "This server's sign-in uses a flow Octant does not run here.");
    case "unknown":
      return { kind: "signed-out" };
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > METADATA_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return undefined;
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      probe.close(() => (port === undefined ? reject(new Error("no port")) : resolve(port)));
    });
  });
}

function canonicalResource(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  const text = url.toString();
  return text.endsWith("/") && url.pathname === "/" ? text.slice(0, -1) : text;
}

function isHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isLoopbackHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}
