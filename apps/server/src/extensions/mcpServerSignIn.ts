import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import {
  decodeMcpReportedAccount,
  type McpReportedAccount,
  type McpClientSetupInput,
  type McpServerSignInView,
} from "@octant/contracts/extension-rpc";
import { decodeMcpOAuthClientRegistration } from "@octant/contracts/host-oauth";
import type {
  McpOAuthClientRegistration,
  HostOAuthDescriptor,
  HostOAuthSignInAgainReason,
  HostOAuthSignInState,
  GithubMcpPermissionProfile,
} from "@octant/contracts/host-oauth";
import {
  GOOGLE_WORKSPACE_MCP_OAUTH,
  googleWorkspaceMcpScopes,
  type GithubActionsSourceRead,
  type GithubActionsSourceResult,
  type GithubActionsRepository,
  decodeGithubActionsSourceResult,
  GITHUB_MCP_REPOSITORY_PROFILE,
  SLACK_MCP_USER_OAUTH,
  GITHUB_MCP_OAUTH_APP,
  githubMcpRequiredScopes,
  isGithubMcpDescriptorBinding,
  decodeGithubMcpAccount,
  mcpOAuthResourceForTransport,
  isSlackMcpUserDescriptorBinding,
} from "@octant/host-runtime";
import type { AgentPluginsMcpLaunchSpec } from "@octant/plugin-host/agent-plugins";
import type { GeneratedMcpSignInPolicy, LinkedSecretPointers } from "./userAddedMcpServers";
import type { HostOAuthService } from "../providers/oauth/hostOAuthService";

const TERMS_ID = "mcp-sign-in-terms-1";
const METADATA_BYTES = 64 * 1_024;
const REQUEST_TIMEOUT_MS = 10_000;
// Begin runs inside the resource queue, so a broker that accepts Begin and never
// answers would otherwise hold sign-out, setup and removal for that server
// forever. The bound stays under the renderer's 30-second request deadline.
const BEGIN_TIMEOUT_MS = 20_000;
const MAX_CLIENT_SECRET_REFERENCES = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// RFC 6749 §3.3 scope-token: a resource may advertise URL-shaped scopes, and
// dropping one silently would register and authorize without it.
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/;

type PrincipalKind = "local-window" | "remote-device";

export interface McpServerSignInRecord {
  readonly credentialRef: string;
  readonly descriptor: HostOAuthDescriptor;
  readonly issuer: string;
  /** Set once the broker answered that the grant is gone; Settings then says Sign in again. */
  readonly signInAgain?: McpSignInAgainReason;
  readonly signOutPending?: boolean;
  readonly refreshRequired?: boolean;
  readonly account?: McpReportedAccount;
}

type AwaitingConsent = Extract<McpServerSignInView, { kind: "awaiting-consent" }>;

interface PersistedSignIns {
  readonly schemaVersion: 1;
  readonly signIns: Readonly<Record<string, McpServerSignInRecord>>;
  readonly retiredClientSecrets?: ReadonlyArray<string>;
  readonly callbackPorts?: Readonly<Record<string, number>>;
  readonly registrations?: Readonly<Record<string, McpOAuthClientRegistration>>;
}

export interface GithubActionsSource {
  readonly current: () => boolean;
  readonly accountId: string;
  readonly repository: GithubActionsRepository;
  readonly runs: (input?: {
    readonly page?: number;
    readonly workflowId?: number;
    readonly branch?: string;
  }) => Promise<GithubActionsSourceResult>;
}

export interface McpServerSignInOptions {
  readonly githubActionsSource?: (
    request: GithubActionsSourceRead,
  ) => Promise<GithubActionsSourceResult>;
  readonly statePath: string;
  readonly oauth: HostOAuthService;
  /** The broker's access route: the bearer for a stored grant, refreshed as needed. */
  readonly access: (credentialRef: string) => Promise<unknown>;
  readonly refresh?: (credentialRef: string) => Promise<unknown>;
  /** The address the component's package names, or undefined for a command server. */
  readonly serverUrl: (extensionId: string, componentId: string) => Promise<string | undefined>;
  /** Host-generated catalog ownership; never a package-supplied policy field. */
  readonly serverPolicy?: (
    extensionId: string,
    componentId: string,
  ) => Promise<GeneratedMcpSignInPolicy | undefined>;
  readonly fetch?: typeof fetch;
  readonly actorId: string;
  readonly now?: () => Date;
  /** Existing MCP broker pointer ingress; it handles item addresses, never secret values. */
  readonly linkedSecrets?: LinkedSecretPointers;
  /** Picks the loopback port the callback will listen on; the default binds and releases a free one. */
  readonly pickPort?: () => Promise<number>;
  readonly pointTimeoutMs?: number;
  readonly retirementTimeoutMs?: number;
  /** Fences cached task transports when this component's broker grant changes. */
  readonly onAuthenticationChanged?: (extensionId: string, componentId: string) => Promise<void>;
  readonly beginTimeoutMs?: number;
  /** State replacement boundary; the default writes an owner-only file then atomically renames it. */
  readonly replaceState?: (path: string, contents: string) => Promise<void>;
}

type Discovered =
  | {
      readonly kind: "discovered";
      readonly resource: string;
      readonly transportUrl: string;
      readonly mcpDialect: "mcp-authorization" | "slack-mcp-user" | "github-mcp-oauth-app";
      readonly issuer: string;
      readonly authorizationEndpoint: string;
      readonly tokenEndpoint: string;
      readonly registrationEndpoint: string | undefined;
      readonly issuerUrl: string;
      readonly metadataClientSupported: boolean;
      readonly tokenAuthenticationMethods: ReadonlyArray<string>;
      readonly scopes: ReadonlyArray<string>;
    }
  | { readonly kind: "no-sign-in-offered" }
  | { readonly kind: "issuer-unsupported"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Sign-in to a hosted MCP server, the way the MCP authorization flow lays it
 * out: the server answers a bare request with 401 and names its protected
 * resource metadata; that names the authorization server; the server's
 * metadata names the endpoints; Octant uses a configured application client
 * or registers a public client there (RFC 7591), then runs the host's own PKCE flow with the server's
 * canonical address as the `resource`. The grant lives in the credential
 * broker; this service keeps only its reference, the descriptor that made it
 * and the issuer's name, so a refresh and a sign-out can find it again.
 */
export class McpServerSignIn {
  readonly #options: McpServerSignInOptions;
  readonly #fetch: typeof fetch;
  #signIns = new Map<string, McpServerSignInRecord>();
  readonly #retiredClientSecrets = new Set<string>();
  readonly #retirementStarted = new Set<string>();
  readonly #callbackPorts = new Map<string, number>();
  readonly #registrations = new Map<string, McpOAuthClientRegistration>();
  readonly #attempts = new Map<
    string,
    {
      readonly attemptId: string;
      readonly discovered: Extract<Discovered, { kind: "discovered" }>;
      readonly descriptor: HostOAuthDescriptor;
      /** The last state shown, so a paired device can read it without polling. */
      readonly view: AwaitingConsent;
      cancelPending?: boolean;
      statusUnavailable?: boolean;
    }
  >();
  #loading: Promise<void> | undefined;
  readonly #operations = new Map<string, Promise<unknown>>();
  /** Known component/resource queue ownership lets uninstall wait for an in-flight Begin. */
  readonly #serverResources = new Map<string, Set<string>>();
  readonly #removals = new Map<string, number>();
  #commits: Promise<unknown> = Promise.resolve();

  constructor(options: McpServerSignInOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  // Setup and consent for one resource cannot interleave while discovery or
  // secret linking is pending. Other resources and ordinary bearer reads remain usable.
  #serialized<T>(resource: string, operation: () => Promise<T>): Promise<T> {
    const run = (this.#operations.get(resource) ?? Promise.resolve()).then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#operations.set(resource, settled);
    void settled.then(() => {
      if (this.#operations.get(resource) === settled) this.#operations.delete(resource);
    });
    return run;
  }

  async #forServer(
    extensionId: string,
    componentId: string,
    operation: () => Promise<McpServerSignInView>,
  ): Promise<McpServerSignInView> {
    const url = await this.#options.serverUrl(extensionId, componentId);
    const key = signInKey(extensionId, componentId);
    const resource = url === undefined ? key : mcpOAuthResourceForTransport(canonicalResource(url));
    const resources = this.#serverResources.get(key) ?? new Set<string>();
    resources.add(resource);
    this.#serverResources.set(key, resources);
    return this.#serialized(resource, operation);
  }

  // Whole mutations, including rollback, own this short queue until the atomic
  // state replacement ends. No discovery, token access/refresh or item lookup runs here.
  #commit<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#commits.then(operation);
    this.#commits = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  prepareClient(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    return this.#forServer(extensionId, componentId, () =>
      this.#prepareClient(extensionId, componentId, principalKind),
    );
  }
  saveClient(
    extensionId: string,
    componentId: string,
    setup: McpClientSetupInput,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    if (this.#removals.has(extensionId))
      return Promise.resolve(
        refused("unavailable", "Finish removing this server before starting another sign-in."),
      );
    return this.#forServer(extensionId, componentId, () =>
      this.#saveClient(extensionId, componentId, setup, principalKind),
    );
  }
  configureForServer(
    extensionId: string,
    componentId: string,
    registration: McpOAuthClientRegistration,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    return this.#forServer(extensionId, componentId, () =>
      this.#configureForServer(extensionId, componentId, registration, principalKind),
    );
  }
  configureClient(
    input: unknown,
    principalKind: PrincipalKind,
  ): Promise<{ readonly kind: "configured" } | Extract<McpServerSignInView, { kind: "refused" }>> {
    let resource: string;
    try {
      resource = canonicalResource(decodeMcpOAuthClientRegistration(input).resource);
    } catch {
      return this.#configureClient(input, principalKind);
    }
    return this.#serialized(resource, () => this.#configureClient(input, principalKind));
  }
  status(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    return this.#status(extensionId, componentId, principalKind);
  }
  begin(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    if (this.#removals.has(extensionId))
      return Promise.resolve(
        refused("unavailable", "Finish removing this server before starting another sign-in."),
      );
    return this.#forServer(extensionId, componentId, () =>
      this.#begin(extensionId, componentId, principalKind),
    );
  }
  poll(
    extensionId: string,
    componentId: string,
    attemptId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    return this.#forServer(extensionId, componentId, () =>
      this.#pollForServer(extensionId, componentId, attemptId, principalKind),
    );
  }
  signOut(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    return this.#forServer(extensionId, componentId, async () => {
      if (principalKind === "local-window" && this.#removals.has(extensionId)) {
        await this.#load();
        const record = this.#signIns.get(signInKey(extensionId, componentId));
        return record?.signOutPending
          ? recordView(record)
          : refused("unavailable", "Finish removing this server before changing its sign-in.");
      }
      return this.#signOut(extensionId, componentId, principalKind);
    });
  }
  async preparePackageRemoval(extensionId: string): Promise<() => void> {
    this.#removals.set(extensionId, (this.#removals.get(extensionId) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (this.#removals.get(extensionId) ?? 1) - 1;
      if (remaining === 0) this.#removals.delete(extensionId);
      else this.#removals.set(extensionId, remaining);
    };
    try {
      await this.#load();
      const prefix = `${extensionId}:`;
      for (const resource of this.#packageResources(extensionId))
        await this.#serialized(resource, async () => {
          if (
            Array.from(this.#signIns).some(
              ([key, record]) =>
                key.startsWith(prefix) &&
                record.descriptor.resource === resource &&
                record.signOutPending,
            )
          )
            throw new Error("Finish signing out before removing this server.");
          for (const [key, pending] of Array.from(this.#attempts))
            if (key.startsWith(prefix) && pending.discovered.resource === resource) {
              if (!(await this.#cancelPending(key, "local-window")))
                throw new Error(
                  "Sign-in cancellation is not confirmed. Restore the credential broker and retry removal.",
                );
            }
        });
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  forgetPackage(extensionId: string): Promise<void> {
    return this.#forgetPackage(extensionId);
  }
  attachBearer(
    extensionId: string,
    componentId: string,
    launch: AgentPluginsMcpLaunchSpec,
  ): Promise<AgentPluginsMcpLaunchSpec> {
    return this.#attachBearer(extensionId, componentId, launch);
  }

  /** Explicit setup discovery neither registers a client nor starts account consent. */
  async #prepareClient(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
    retainPolicy?: (policy: GeneratedMcpSignInPolicy) => void,
  ): Promise<McpServerSignInView> {
    if (principalKind !== "local-window")
      return refused("local-host-required", "Set up the client on this host.");
    const url = await this.#options.serverUrl(extensionId, componentId);
    if (url === undefined) return { kind: "not-applicable" };
    const policy = await this.#readServerPolicy(extensionId, componentId, url);
    if (policy === undefined)
      return refused(
        "unavailable",
        "The server's app permission policy is no longer current. Reopen this connection.",
      );
    const discovered = await this.#discover(url, policy.mcpPermissionProfile);
    if (!policy.current())
      return refused(
        "unavailable",
        "The server changed while preparing sign-in. Reopen this connection.",
      );
    if (discovered.kind === "no-sign-in-offered")
      return refused("no-sign-in-offered", "This server does not offer browser sign-in.");
    if (discovered.kind !== "discovered") return refused(discovered.kind, discovered.message);
    await this.#load();
    const registration = this.#registrations.get(discovered.resource);
    let port = registration?.redirectPort ?? this.#callbackPorts.get(discovered.resource);
    if (port === undefined) {
      try {
        port = await (this.#options.pickPort ?? pickFreePort)();
        const selected = port;
        await this.#commit(async () => {
          this.#callbackPorts.set(discovered.resource, selected);
          try {
            await this.#persist();
          } catch (error) {
            this.#callbackPorts.delete(discovered.resource);
            throw error;
          }
        });
      } catch {
        return refused("unavailable", "The sign-in callback could not be prepared. Try again.");
      }
    }
    if (!policy.current())
      return refused(
        "unavailable",
        "The server changed while preparing app setup. Reopen this connection.",
      );
    retainPolicy?.(policy);
    return {
      kind: "client-setup",
      ...(policy.mcpPermissionProfile === undefined
        ? {}
        : { mcpPermissionProfile: policy.mcpPermissionProfile }),
      resource: discovered.resource,
      issuer: discovered.issuerUrl,
      tokenEndpoint: discovered.tokenEndpoint,
      callback: `http://${discovered.mcpDialect === SLACK_MCP_USER_OAUTH.dialect ? "localhost" : "127.0.0.1"}:${port}/oauth/callback`,
      metadataClientSupported: discovered.metadataClientSupported,
      authenticationMethods: discovered.tokenAuthenticationMethods.filter(
        (method): method is "none" | "client_secret_post" | "client_secret_basic" =>
          method === "none" || method === "client_secret_post" || method === "client_secret_basic",
      ),
      secretStoreAvailable: this.#options.linkedSecrets !== undefined,
      ...(registration === undefined ? {} : { registration }),
    };
  }

  async #saveClient(
    extensionId: string,
    componentId: string,
    input: McpClientSetupInput,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    if (this.#removals.has(extensionId))
      return refused("unavailable", "Finish removing this server before starting another sign-in.");
    if (principalKind !== "local-window")
      return refused("local-host-required", "Set up the client on this host.");
    if (this.#attempts.has(signInKey(extensionId, componentId)))
      return refused("unavailable", "Finish the pending sign-in before changing client setup.");
    const preparedOwner: { policy?: GeneratedMcpSignInPolicy } = {};
    const prepared = await this.#prepareClient(
      extensionId,
      componentId,
      principalKind,
      (policy) => {
        preparedOwner.policy = policy;
      },
    );
    if (prepared.kind !== "client-setup") return prepared;
    const retainedPolicy = preparedOwner.policy;
    if (retainedPolicy === undefined || !retainedPolicy.current())
      return refused(
        "unavailable",
        "The server changed while preparing app setup. Reopen Client setup.",
      );
    if (
      Array.from(this.#attempts.values()).some(
        (pending) => pending.discovered.resource === prepared.resource,
      )
    )
      return refused(
        "unavailable",
        "Finish the pending sign-in for this server before changing client setup.",
      );
    if (
      input.binding.resource !== prepared.resource ||
      input.binding.issuer !== prepared.issuer ||
      input.binding.tokenEndpoint !== prepared.tokenEndpoint ||
      input.binding.callback !== prepared.callback ||
      input.binding.mcpPermissionProfile !== prepared.mcpPermissionProfile
    )
      return refused(
        "invalid",
        "The server's client setup changed. Reopen Client setup and check its addresses before saving.",
      );
    if (
      !prepared.authenticationMethods.includes(input.authentication) ||
      (input.kind === "metadata-document" &&
        (!prepared.metadataClientSupported || input.authentication !== "none"))
    )
      return refused(
        "issuer-unsupported",
        "The authorization server does not support this client setup.",
      );
    if (input.authentication === "none" && input.secret !== undefined)
      return refused("invalid", "A public client does not use a client secret.");
    const existing = prepared.registration?.clientAuthentication;
    const reuseSecret =
      input.secret === undefined &&
      prepared.registration?.clientId === input.clientId &&
      prepared.registration.issuer === prepared.issuer &&
      existing?.method === input.authentication &&
      existing.tokenEndpoint === prepared.tokenEndpoint;
    if (
      input.authentication !== "none" &&
      !reuseSecret &&
      (input.secret === undefined || this.#options.linkedSecrets === undefined)
    )
      return refused(
        "unavailable",
        "Choose a client secret from a linked secret store on this host.",
      );
    const secretRef =
      input.authentication === "none"
        ? undefined
        : reuseSecret
          ? existing?.secretRef
          : randomUUID();
    let registration: McpOAuthClientRegistration;
    try {
      registration = decodeMcpOAuthClientRegistration({
        kind: input.kind,
        resource: prepared.resource,
        issuer: prepared.issuer,
        clientId: input.clientId,
        redirectPort: Number(new URL(prepared.callback).port),
        ...(prepared.resource === SLACK_MCP_USER_OAUTH.resource
          ? { redirectHostname: "localhost" }
          : {}),
        ...(secretRef === undefined
          ? {}
          : {
              clientAuthentication: {
                method: input.authentication,
                secretRef,
                tokenEndpoint: prepared.tokenEndpoint,
              },
            }),
      });
    } catch {
      return refused("invalid", "Enter a valid client ID for this registration method.");
    }
    if (!reuseSecret && secretRef !== undefined && input.secret !== undefined) {
      const reserved = await this.#commit(async () => {
        if (this.#trackedClientSecrets().size >= MAX_CLIENT_SECRET_REFERENCES) return false;
        this.#retiredClientSecrets.add(secretRef);
        try {
          await this.#persist();
          return true;
        } catch {
          this.#retiredClientSecrets.delete(secretRef);
          return false;
        }
      });
      if (!reserved)
        return refused(
          "unavailable",
          "Client-secret cleanup or storage needs attention. See “Recover retired client-secret references” in the Plugins and skills guide before adding another secret.",
        );
      // A failed/lost point reply does not cancel the broker's delayed set. A
      // later clear:none therefore cannot prove that this UUID is safe to reuse.
      const linking = this.#options.linkedSecrets?.point(secretRef, input.secret).catch(() => ({
        status: "uncertain" as const,
        message: "The linked secret store is unavailable.",
      }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pointed: Awaited<typeof linking>;
      try {
        pointed = await Promise.race([
          linking,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(
              () => resolve(undefined),
              this.#options.pointTimeoutMs ?? REQUEST_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (pointed === undefined) {
        this.#retirementStarted.add(secretRef);
        // Only the original operation's definitive completion may schedule
        // retirement. It never configures a client after the caller timed out.
        void linking
          ?.then(async (late) => {
            if (late?.status !== "pointed" && late?.status !== "refused") return;
            this.#retirementStarted.delete(secretRef);
            await this.#retireUnusedSecret(secretRef);
          })
          .catch(() => undefined);
        return refused(
          "unavailable",
          "The secret store did not finish. Your client setup was not changed. Try again; the pending reference will not be reused.",
        );
      }
      if (pointed.status === "uncertain") {
        this.#retirementStarted.add(secretRef);
        return refused(
          "unavailable",
          "The client secret lookup could not be confirmed. Your client setup was not changed. Retry to link a fresh reference.",
        );
      }
      if (pointed.status !== "pointed") {
        await this.#retireUnusedSecret(secretRef);
        return refused("unavailable", pointed.message);
      }
    }
    try {
      const saved = await this.#configureForServer(
        extensionId,
        componentId,
        registration,
        principalKind,
        !reuseSecret ? secretRef : undefined,
        {
          current: retainedPolicy.current,
          ...(prepared.mcpPermissionProfile === undefined
            ? {}
            : { mcpPermissionProfile: prepared.mcpPermissionProfile }),
        },
      );
      if (
        saved.kind !== "signed-out" &&
        saved.kind !== "signed-in" &&
        saved.kind !== "sign-in-again"
      ) {
        if (!reuseSecret && secretRef !== undefined) await this.#retireUnusedSecret(secretRef);
        return saved.kind === "refused"
          ? saved
          : refused("unavailable", "The server is no longer available for client setup.");
      }
      return { kind: "client-configured" };
    } catch {
      if (!reuseSecret && secretRef !== undefined) await this.#retireUnusedSecret(secretRef);
      return refused("unavailable", "The client setup could not be saved. Try again.");
    }
  }

  async #configureForServer(
    extensionId: string,
    componentId: string,
    registration: McpOAuthClientRegistration,
    principalKind: PrincipalKind,
    reservedSecretRef?: string,
    shownPolicy?: {
      readonly mcpPermissionProfile?: GithubMcpPermissionProfile;
      readonly current?: () => boolean;
    },
  ): Promise<McpServerSignInView> {
    if (principalKind !== "local-window")
      return refused("local-host-required", "Set up the client on this host.");
    const url = await this.#options.serverUrl(extensionId, componentId);
    if (url === undefined) return { kind: "not-applicable" };
    const transportUrl = canonicalResource(url);
    if (canonicalResource(registration.resource) !== mcpOAuthResourceForTransport(transportUrl)) {
      return refused("invalid", "This client setup names a different MCP server.");
    }
    if (
      transportUrl === SLACK_MCP_USER_OAUTH.transportUrl &&
      (registration.issuer !== SLACK_MCP_USER_OAUTH.issuer ||
        registration.kind !== "registered" ||
        registration.clientAuthentication?.method !== "client_secret_post" ||
        registration.clientAuthentication.tokenEndpoint !== SLACK_MCP_USER_OAUTH.tokenEndpoint)
    )
      return refused(
        "issuer-unsupported",
        "This server advertises a registered client using client_secret_post; public-client compatibility is not established.",
      );
    if (
      transportUrl === GITHUB_MCP_OAUTH_APP.transportUrl &&
      !githubRegistrationReady(registration)
    )
      return refused(
        "issuer-unsupported",
        "This read connector requires your registered OAuth App, linked app secret, and exact retained loopback callback.",
      );
    const policy = await this.#readServerPolicy(extensionId, componentId, url);
    if (
      policy === undefined ||
      !policy.current() ||
      shownPolicy?.current?.() === false ||
      (shownPolicy !== undefined &&
        shownPolicy.mcpPermissionProfile !== policy.mcpPermissionProfile)
    )
      return refused(
        "invalid",
        "The server's app permission policy changed. Reopen Client setup before saving.",
      );
    const result = await this.#configureClient(
      registration,
      principalKind,
      reservedSecretRef,
      () => policy.current() && shownPolicy?.current?.() !== false,
    );
    if (result.kind !== "configured") return result;
    const key = signInKey(extensionId, componentId);
    const pending = this.#attempts.get(key);
    if (pending !== undefined) return pending.view;
    const record = this.#signIns.get(key);
    return record === undefined ? { kind: "signed-out" } : recordView(record);
  }

  /** Saves application setup only; consent and account grants remain separate host actions. */
  async #configureClient(
    input: unknown,
    principalKind: PrincipalKind,
    reservedSecretRef?: string,
    current?: () => boolean,
  ): Promise<{ readonly kind: "configured" } | Extract<McpServerSignInView, { kind: "refused" }>> {
    if (principalKind !== "local-window")
      return {
        kind: "refused",
        reason: "local-host-required",
        message: "Set up the client on this host.",
      };
    let registration: McpOAuthClientRegistration;
    try {
      registration = decodeMcpOAuthClientRegistration(input);
    } catch {
      return {
        kind: "refused",
        reason: "issuer-unsupported",
        message: "The client setup is invalid.",
      };
    }
    if (!isHttps(registration.issuer) || !isHttps(registration.resource))
      return {
        kind: "refused",
        reason: "issuer-unsupported",
        message: "The client setup needs https issuer and resource addresses.",
      };
    await this.#load();
    let superseded: string | undefined;
    const result = await this.#commit(async () => {
      if (current?.() === false)
        return refused(
          "unavailable",
          "The server changed before app setup could be saved. Reopen Client setup.",
        );
      const key = canonicalResource(registration.resource);
      if (
        Array.from(this.#attempts.values()).some((pending) => pending.discovered.resource === key)
      )
        return refused(
          "unavailable",
          "Finish the pending sign-in for this server before changing client setup.",
        );
      const nextRef = registration.clientAuthentication?.secretRef;
      if (
        nextRef !== undefined &&
        this.#retiredClientSecrets.has(nextRef) &&
        nextRef !== reservedSecretRef
      )
        return refused(
          "invalid",
          "That client-secret reference is retired. Link the item again to use a fresh reference.",
        );
      const tracked = this.#trackedClientSecrets();
      if (
        nextRef !== undefined &&
        !tracked.has(nextRef) &&
        tracked.size >= MAX_CLIENT_SECRET_REFERENCES
      )
        return refused(
          "unavailable",
          "Client-secret cleanup needs attention. See “Recover retired client-secret references” in the Plugins and skills guide before adding another secret.",
        );
      const previous = this.#registrations.get(key);
      const oldRef = previous?.clientAuthentication?.secretRef;
      const previouslyReserved = nextRef !== undefined && this.#retiredClientSecrets.has(nextRef);
      this.#registrations.set(key, registration);
      if (nextRef !== undefined) this.#retiredClientSecrets.delete(nextRef);
      const reservedOld = this.#reserveUnownedSecret(oldRef);
      try {
        await this.#persist();
      } catch {
        if (previous === undefined) this.#registrations.delete(key);
        else this.#registrations.set(key, previous);
        if (previouslyReserved && nextRef !== undefined) this.#retiredClientSecrets.add(nextRef);
        if (reservedOld && oldRef !== undefined) this.#retiredClientSecrets.delete(oldRef);
        return refused("unavailable", "The client setup could not be saved. Try again.");
      }
      superseded = previous?.clientAuthentication?.secretRef;
      return { kind: "configured" as const };
    });
    if (result.kind === "configured") await this.#retireUnusedSecret(superseded);
    return result;
  }

  #ownedClientSecrets(): Set<string> {
    const references = new Set<string>();
    for (const entry of this.#registrations.values())
      if (entry.clientAuthentication !== undefined)
        references.add(entry.clientAuthentication.secretRef);
    for (const entry of this.#signIns.values())
      if (entry.descriptor.clientAuthentication !== undefined)
        references.add(entry.descriptor.clientAuthentication.secretRef);
    for (const entry of this.#attempts.values())
      if (entry.descriptor.clientAuthentication !== undefined)
        references.add(entry.descriptor.clientAuthentication.secretRef);
    return references;
  }

  #trackedClientSecrets(): Set<string> {
    return new Set([...this.#ownedClientSecrets(), ...this.#retiredClientSecrets]);
  }

  /** Transfer the last owner to a durable reservation in the same commit. */
  #reserveUnownedSecret(secretRef: string | undefined): boolean {
    if (
      secretRef === undefined ||
      this.#ownedClientSecrets().has(secretRef) ||
      this.#retiredClientSecrets.has(secretRef)
    )
      return false;
    this.#retiredClientSecrets.add(secretRef);
    return true;
  }

  /** Only the original definitive clear may release its reservation; unknown outcomes are never replayed. */
  async #retireUnusedSecret(secretRef: string | undefined): Promise<void> {
    if (secretRef === undefined || this.#options.linkedSecrets === undefined) return;
    const start = await this.#commit(async () => {
      if (this.#ownedClientSecrets().has(secretRef) || this.#retirementStarted.has(secretRef))
        return false;
      if (this.#reserveUnownedSecret(secretRef)) await this.#persist();
      this.#retirementStarted.add(secretRef);
      return true;
    });
    if (!start) return;
    // No broker operation runs under the shared commit queue. If the reply is
    // lost or exceeds the deadline, this opaque id stays reserved across restart.
    const clear = (async () => {
      try {
        if (this.#options.linkedSecrets?.retire !== undefined)
          return await this.#options.linkedSecrets.retire(secretRef);
        await this.#options.linkedSecrets?.forget(secretRef);
      } catch {
        /* The deletion outcome remains unknown. */
      }
      return "uncertain";
    })();
    const completed = clear.then(async (outcome) => {
      if (outcome !== "cleared") return;
      await this.#commit(async () => {
        this.#retiredClientSecrets.delete(secretRef);
        try {
          await this.#persist();
          this.#retirementStarted.delete(secretRef);
        } catch {
          this.#retiredClientSecrets.add(secretRef);
        }
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.#options.retirementTimeoutMs ?? REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The state as of now. A local window polls a pending attempt, which may
   * finish it; a paired device only reads what is known, since finishing a
   * sign-in is a host action (observed: a remote status read used to poll
   * as the local window and could persist the grant).
   */
  async #status(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    await this.#load();
    const key = signInKey(extensionId, componentId);
    const pending = this.#attempts.get(key);
    if (pending !== undefined) {
      if (pending.cancelPending) return cancellationPending();
      return principalKind === "local-window"
        ? this.poll(extensionId, componentId, pending.attemptId, principalKind)
        : pending.statusUnavailable
          ? statusUnavailable()
          : pending.view;
    }
    const record = this.#signIns.get(key);
    if (record !== undefined) return recordView(record);
    const url = await this.#options.serverUrl(extensionId, componentId);
    if (url === undefined) return { kind: "not-applicable" };
    if (
      googleWorkspaceMcpScopes(canonicalResource(url)) !== undefined &&
      this.#registrations.get(canonicalResource(url)) === undefined
    )
      return {
        kind: "client-setup-required",
        message: "Set up your enrolled Google Workspace Desktop client before signing in.",
      };
    if (
      canonicalResource(url) === SLACK_MCP_USER_OAUTH.transportUrl &&
      !slackRegistrationReady(this.#registrations.get(SLACK_MCP_USER_OAUTH.resource))
    )
      return {
        kind: "client-setup-required",
        message: "Set up your registered app before signing in.",
      };
    if (
      canonicalResource(url) === GITHUB_MCP_OAUTH_APP.transportUrl &&
      !githubRegistrationReady(this.#registrations.get(GITHUB_MCP_OAUTH_APP.resource))
    )
      return {
        kind: "client-setup-required",
        message: "Set up your registered OAuth App before signing in.",
      };
    return { kind: "signed-out" };
  }

  async #begin(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    if (this.#removals.has(extensionId))
      return refused("unavailable", "Finish removing this server before starting another sign-in.");
    await this.#load();
    if (principalKind !== "local-window") {
      return refused("local-host-required", "Sign in from the Octant window on this host.");
    }
    const key = signInKey(extensionId, componentId);
    const previous = this.#signIns.get(key);
    if (previous !== undefined) {
      if (previous.signOutPending || previous.signInAgain === undefined)
        return recordView(previous);
      const cleaned = await this.#signOut(extensionId, componentId, principalKind);
      if (cleaned.kind !== "signed-out") return cleaned;
    }
    const existing = this.#attempts.get(key);
    if (existing !== undefined)
      return existing.cancelPending
        ? cancellationPending()
        : existing.statusUnavailable
          ? statusUnavailable()
          : existing.view;
    const url = await this.#options.serverUrl(extensionId, componentId);
    if (url === undefined) return { kind: "not-applicable" };
    const policy = await this.#readServerPolicy(extensionId, componentId, url);
    if (policy === undefined)
      return refused(
        "unavailable",
        "The server's app permission policy is no longer current. Reopen this connection.",
      );
    const discovered = await this.#discover(url, policy.mcpPermissionProfile);
    if (!policy.current())
      return refused(
        "unavailable",
        "The server changed while preparing sign-in. Reopen this connection.",
      );
    if (discovered.kind === "no-sign-in-offered") {
      return refused("no-sign-in-offered", "This server answered without asking for a sign-in.");
    }
    if (discovered.kind === "issuer-unsupported") {
      return refused("issuer-unsupported", discovered.message);
    }
    if (discovered.kind === "unavailable") return refused("unavailable", discovered.message);
    const setup = this.#registrations.get(discovered.resource);
    if (
      googleWorkspaceMcpScopes(discovered.resource) !== undefined &&
      (setup?.kind !== "registered" ||
        !/^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/.test(setup.clientId) ||
        setup.clientAuthentication !== undefined)
    )
      return refused(
        "issuer-unsupported",
        "Use an agentic Desktop app client for your enrolled Google Workspace project. No client secret is needed.",
      );
    if (
      setup !== undefined &&
      (setup.issuer !== discovered.issuerUrl ||
        (setup.kind === "metadata-document" && !discovered.metadataClientSupported) ||
        (setup.clientAuthentication !== undefined &&
          (!discovered.tokenAuthenticationMethods.includes(setup.clientAuthentication.method) ||
            setup.clientAuthentication.tokenEndpoint !== discovered.tokenEndpoint)))
    ) {
      return refused(
        "issuer-unsupported",
        "The authorization server does not support this client setup or its issuer binding.",
      );
    }
    if (setup === undefined && discovered.registrationEndpoint === undefined) {
      return refused(
        "client-registration-unavailable",
        "Set up a registered OAuth client for this server before signing in.",
      );
    }
    if (discovered.mcpDialect === SLACK_MCP_USER_OAUTH.dialect) {
      if (
        setup?.clientAuthentication?.method !== "client_secret_post" ||
        !discovered.tokenAuthenticationMethods.includes("client_secret_post")
      )
        return refused(
          "issuer-unsupported",
          "This authorization server does not advertise public-client authentication. Use its supported registered-client setup.",
        );
      if (setup.redirectHostname !== "localhost")
        return refused(
          "issuer-unsupported",
          "Update this app setup with its exact retained localhost callback before signing in.",
        );
    }
    if (discovered.mcpDialect === GITHUB_MCP_OAUTH_APP.dialect && !githubRegistrationReady(setup))
      return refused(
        "issuer-unsupported",
        "Use your registered OAuth App with its retained loopback callback and linked app secret.",
      );
    let port: number;
    try {
      port = setup?.redirectPort ?? (await (this.#options.pickPort ?? pickFreePort)());
    } catch {
      return refused("unavailable", "No loopback port was free for the sign-in callback.");
    }
    const redirectUri = `http://${setup?.redirectHostname ?? "127.0.0.1"}:${port}/oauth/callback`;
    const registered =
      setup === undefined
        ? await this.#register(
            discovered.registrationEndpoint ?? "",
            redirectUri,
            discovered.scopes,
          )
        : { kind: "registered" as const, clientId: setup.clientId };
    if (registered.kind !== "registered") return refused("issuer-unsupported", registered.message);
    const descriptor: HostOAuthDescriptor = {
      descriptorId: `mcp-${digest(key)}` as HostOAuthDescriptor["descriptorId"],
      clientId: registered.clientId as HostOAuthDescriptor["clientId"],
      dialect: discovered.mcpDialect,
      ...(policy.mcpPermissionProfile === undefined
        ? {}
        : { mcpPermissionProfile: policy.mcpPermissionProfile }),
      flow: "authorization-code-pkce",
      authorizationEndpoint:
        discovered.authorizationEndpoint as HostOAuthDescriptor["authorizationEndpoint"],
      tokenEndpoint: discovered.tokenEndpoint as HostOAuthDescriptor["tokenEndpoint"],
      scopes: discovered.scopes as HostOAuthDescriptor["scopes"],
      termsId: TERMS_ID as HostOAuthDescriptor["termsId"],
      resource: discovered.resource as HostOAuthDescriptor["resource"],
      redirectPort: port,
      ...(discovered.mcpDialect === SLACK_MCP_USER_OAUTH.dialect
        ? {
            redirectHostname: "localhost" as const,
            mcpIssuer: discovered.issuerUrl,
            mcpTransportUrl: discovered.transportUrl,
          }
        : discovered.mcpDialect === GITHUB_MCP_OAUTH_APP.dialect
          ? { mcpIssuer: discovered.issuerUrl, mcpTransportUrl: discovered.transportUrl }
          : {}),
      ...(setup?.clientAuthentication === undefined
        ? {}
        : { clientAuthentication: setup.clientAuthentication }),
    };
    // The person's click is the acknowledgment: there is no vendor terms text
    // for a server they added themselves, only the host's own notice.
    const acknowledged = this.#options.oauth.acknowledgeTerms({
      principalKind,
      actorId: this.#options.actorId,
      descriptor,
    });
    if (acknowledged.kind === "refused") return fromRefusal(acknowledged.reason);
    if (!policy.current() || this.#removals.has(extensionId))
      return refused(
        "unavailable",
        "The server changed before sign-in could start. Reopen this connection.",
      );
    const state = await this.#boundedBegin(principalKind, descriptor);
    if (state === "timed-out")
      return refused("unavailable", "The credential broker did not start the sign-in. Try again.");
    if (state.kind === "awaiting-consent" && state.flow === "authorization-code-pkce") {
      const view: AwaitingConsent = {
        kind: "awaiting-consent",
        attemptId: state.attemptId,
        authorizationUrl: state.authorizationUrl,
        expiresAt: state.expiresAt,
      };
      this.#attempts.set(key, { attemptId: state.attemptId, discovered, descriptor, view });
      return view;
    }
    return viewOf(state, discovered.issuer);
  }

  /**
   * A Begin the broker answers after the deadline names an attempt nobody owns;
   * it is cancelled so its callback and retained port are released rather than
   * left until the attempt expires.
   */
  async #boundedBegin(
    principalKind: PrincipalKind,
    descriptor: HostOAuthDescriptor,
  ): Promise<HostOAuthSignInState | "timed-out"> {
    const started = this.#options.oauth.begin({
      principalKind,
      actorId: this.#options.actorId,
      descriptor,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      started,
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(
          () => resolve("timed-out"),
          this.#options.beginTimeoutMs ?? BEGIN_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (outcome !== "timed-out") return outcome;
    void started
      .then((late) =>
        late.kind === "awaiting-consent"
          ? this.#options.oauth.cancel({
              principalKind,
              actorId: this.#options.actorId,
              attemptId: late.attemptId,
              descriptor,
            })
          : undefined,
      )
      .catch(() => undefined);
    return "timed-out";
  }

  async #pollForServer(
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
      return record === undefined ? { kind: "signed-out" } : recordView(record);
    }
    // Polling can finish the attempt and store the grant; a paired device
    // may neither, and the broker's own refusal must not end the attempt.
    if (principalKind !== "local-window") {
      return refused("local-host-required", "Sign in from the Octant window on this host.");
    }
    if (pending.cancelPending) return cancellationPending();
    const state = await this.#options.oauth.status({
      principalKind,
      attemptId,
      descriptor: pending.descriptor,
    });
    if (pending.cancelPending) return cancellationPending();
    if (this.#attempts.get(key) !== pending) {
      const record = this.#signIns.get(key);
      return record === undefined ? { kind: "signed-out" } : recordView(record);
    }
    const terminal =
      state.kind === "refused" &&
      ["denied", "timeout", "state-mismatch", "verifier-mismatch", "exchange-refused"].includes(
        state.reason,
      );
    if (
      !(
        state.kind === "signed-in" ||
        (state.kind === "awaiting-consent" && state.flow === "authorization-code-pkce") ||
        terminal
      )
    ) {
      pending.statusUnavailable = true;
      return statusUnavailable();
    }
    pending.statusUnavailable = false;
    if (state.kind === "signed-in") {
      let previousRef: string | undefined;
      let committed = false;
      await this.#commit(async () => {
        if (this.#attempts.get(key) !== pending || pending.cancelPending) return;
        previousRef = this.#signIns.get(key)?.descriptor.clientAuthentication?.secretRef;
        this.#attempts.delete(key);
        this.#signIns.set(key, {
          credentialRef: state.credentialRef,
          descriptor: pending.descriptor,
          issuer: pending.discovered.issuer,
        });
        this.#reserveUnownedSecret(previousRef);
        await this.#persist();
        committed = true;
      });
      if (!committed) return pending.cancelPending ? cancellationPending() : { kind: "signed-out" };
      await this.#options.onAuthenticationChanged?.(
        key.slice(0, key.indexOf(":")),
        key.slice(key.indexOf(":") + 1),
      );
      const record = this.#signIns.get(key);
      if (
        record?.descriptor.dialect === SLACK_MCP_USER_OAUTH.dialect ||
        record?.descriptor.dialect === GITHUB_MCP_OAUTH_APP.dialect
      ) {
        try {
          const answer = await this.#credentialStage(() =>
            this.#options.access(record.credentialRef),
          );
          if (isRecord(answer) && answer.kind === "granted") {
            const observed = await this.#observeAccount(key, record, answer);
            if (isRecord(observed) && observed.kind === "sign-in-again")
              await this.#markSignInAgain(
                key,
                record,
                observed.reason,
                key.slice(0, key.indexOf(":")),
                key.slice(key.indexOf(":") + 1),
              );
          }
        } catch {
          /* Account details remain explicitly unreported; the grant already has a durable owner. */
        }
      }
      await this.#retireUnusedSecret(previousRef);
      const current = this.#signIns.get(key);
      return current === undefined ? { kind: "signed-out" } : recordView(current);
    }
    if (state.kind === "refused") {
      let removed = false;
      await this.#commit(async () => {
        if (this.#attempts.get(key) !== pending || pending.cancelPending) return;
        this.#attempts.delete(key);
        removed = true;
        if (this.#reserveUnownedSecret(pending.descriptor.clientAuthentication?.secretRef))
          await this.#persist();
      });
      if (!removed) return pending.cancelPending ? cancellationPending() : { kind: "signed-out" };
      await this.#retireUnusedSecret(pending.descriptor.clientAuthentication?.secretRef);
    }
    if (state.kind === "awaiting-consent" && state.flow === "authorization-code-pkce") {
      const view: AwaitingConsent = {
        kind: "awaiting-consent",
        attemptId: state.attemptId,
        authorizationUrl: state.authorizationUrl,
        expiresAt: state.expiresAt,
      };
      this.#attempts.set(key, { ...pending, view });
      return view;
    }
    return viewOf(state, pending.discovered.issuer);
  }

  async #cancelPending(key: string, principalKind: PrincipalKind): Promise<boolean> {
    const pending = this.#attempts.get(key);
    if (pending === undefined) return true;
    pending.cancelPending = true;
    let result: Awaited<ReturnType<HostOAuthService["cancel"]>>;
    try {
      result = await this.#options.oauth.cancel({
        principalKind,
        actorId: this.#options.actorId,
        attemptId: pending.attemptId,
        descriptor: pending.descriptor,
      });
    } catch {
      return false;
    }
    if (result.kind !== "cancelled") return false;
    await this.#commit(async () => {
      if (this.#attempts.get(key) === pending) this.#attempts.delete(key);
      if (this.#reserveUnownedSecret(pending.descriptor.clientAuthentication?.secretRef))
        await this.#persist();
    });
    await this.#retireUnusedSecret(pending.descriptor.clientAuthentication?.secretRef);
    return true;
  }

  async #signOut(
    extensionId: string,
    componentId: string,
    principalKind: PrincipalKind,
  ): Promise<McpServerSignInView> {
    await this.#load();
    if (principalKind !== "local-window") {
      return refused("local-host-required", "Sign out from the Octant window on this host.");
    }
    const key = signInKey(extensionId, componentId);
    if (!(await this.#cancelPending(key, principalKind))) return cancellationPending();
    const record = this.#signIns.get(key);
    if (record === undefined) {
      await this.#options.onAuthenticationChanged?.(extensionId, componentId);
      return { kind: "signed-out" };
    }
    let pending: McpServerSignInRecord | undefined;
    let persisted = true;
    try {
      await this.#commit(async () => {
        const current = this.#signIns.get(key);
        if (
          current?.credentialRef !== record.credentialRef ||
          current.descriptor !== record.descriptor
        )
          return;
        pending = current.signOutPending ? current : { ...current, signOutPending: true };
        this.#signIns.set(key, pending);
        await this.#persist();
      });
    } catch {
      persisted = false;
    }
    try {
      await this.#options.onAuthenticationChanged?.(extensionId, componentId);
    } catch {
      return signOutPending();
    }
    if (!persisted || pending === undefined || this.#signIns.get(key) !== pending)
      return signOutPending();
    const owner = pending;
    let result: Awaited<ReturnType<HostOAuthService["signOut"]>>;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          this.#options.oauth.signOut({
            principalKind,
            descriptor: owner.descriptor,
            credentialRef: owner.credentialRef,
            forgetWhenNotRevoked: true,
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Sign-out cleanup timed out.")),
              REQUEST_TIMEOUT_MS,
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return signOutPending();
    }
    if (result.kind !== "signed-out" && result.kind !== "signed-out-locally")
      return signOutPending();
    try {
      await this.#commit(async () => {
        if (this.#signIns.get(key) !== owner) return;
        this.#signIns.delete(key);
        const secretRef = owner.descriptor.clientAuthentication?.secretRef;
        const reserved = this.#reserveUnownedSecret(secretRef);
        try {
          await this.#persist();
        } catch (error) {
          this.#signIns.set(key, owner);
          if (reserved && secretRef !== undefined) this.#retiredClientSecrets.delete(secretRef);
          throw error;
        }
      });
    } catch {
      return signOutPending();
    }
    await this.#retireUnusedSecret(owner.descriptor.clientAuthentication?.secretRef);
    return this.#signIns.has(key) ? signOutPending() : { kind: "signed-out" };
  }

  #packageResources(extensionId: string): Set<string> {
    const prefix = `${extensionId}:`;
    const resources = new Set<string>();
    for (const [key, known] of this.#serverResources)
      if (key.startsWith(prefix)) for (const resource of known) resources.add(resource);
    for (const [key, pending] of this.#attempts)
      if (key.startsWith(prefix)) resources.add(pending.discovered.resource);
    for (const [key, record] of this.#signIns)
      if (key.startsWith(prefix) && record.descriptor.resource !== undefined)
        resources.add(record.descriptor.resource);
    return resources;
  }

  /** Forgets a package's sign-ins once it is uninstalled; the grants are revoked where possible. */
  async #forgetPackage(extensionId: string): Promise<void> {
    await this.#load();
    const prefix = `${extensionId}:`;
    const resources = this.#packageResources(extensionId);
    for (const resource of resources)
      await this.#serialized(resource, async () => {
        const keys = new Set<string>();
        for (const [key, pending] of this.#attempts)
          if (key.startsWith(prefix) && pending.discovered.resource === resource) keys.add(key);
        for (const [key, record] of this.#signIns)
          if (key.startsWith(prefix) && record.descriptor.resource === resource) keys.add(key);
        for (const key of keys) {
          const componentId = key.slice(prefix.length);
          const result = await this.#signOut(extensionId, componentId, "local-window");
          if (result.kind !== "signed-out")
            throw new Error("Finish cancelling this server sign-in before removing its setup.");
        }
      });
    for (const key of this.#serverResources.keys())
      if (key.startsWith(prefix)) this.#serverResources.delete(key);
  }

  /** Host-only source capture; the renderer cannot select a credential reference. */
  async bindGithubActionsSource(
    extensionId: string,
    componentId: string,
    selection: {
      readonly owner: string;
      readonly name: string;
      readonly expected?: GithubActionsRepository;
    },
  ): Promise<GithubActionsSource | undefined> {
    const readSource = this.#options.githubActionsSource;
    const selected = {
      owner: selection.owner,
      name: selection.name,
      expected: selection.expected === undefined ? undefined : { ...selection.expected },
    };
    if (this.#options.serverPolicy === undefined || readSource === undefined) return undefined;
    await this.#load();
    const key = signInKey(extensionId, componentId);
    const record = this.#signIns.get(key);
    if (
      record === undefined ||
      !this.#currentGrant(key, record) ||
      this.#removals.has(extensionId) ||
      record.descriptor.dialect !== GITHUB_MCP_OAUTH_APP.dialect ||
      record.descriptor.mcpPermissionProfile !== GITHUB_MCP_REPOSITORY_PROFILE ||
      !isGithubMcpDescriptorBinding(record.descriptor) ||
      record.descriptor.clientId === undefined ||
      record.descriptor.clientAuthentication === undefined ||
      decodeGithubMcpAccount(record.account, GITHUB_MCP_REPOSITORY_PROFILE) === undefined ||
      record.account?.userId === undefined ||
      !/^[1-9]\d{0,15}$/.test(record.account.userId) ||
      !Number.isSafeInteger(Number(record.account.userId))
    )
      return undefined;
    const url = await this.#credentialStage(() =>
      this.#options.serverUrl(extensionId, componentId),
    ).catch(() => undefined);
    if (url !== GITHUB_MCP_OAUTH_APP.transportUrl) return undefined;
    const policy = await this.#readServerPolicy(extensionId, componentId, url);
    if (
      policy?.mcpPermissionProfile !== GITHUB_MCP_REPOSITORY_PROFILE ||
      policy.sourceCurrent?.() !== true
    )
      return undefined;
    let live = true;
    const current = () => {
      try {
        return (
          live &&
          policy.current() &&
          policy.sourceCurrent?.() === true &&
          !this.#removals.has(extensionId) &&
          this.#currentGrant(key, record)
        );
      } catch {
        return false;
      }
    };
    if (!current()) return undefined;
    const owner = {
      credentialRef: record.credentialRef,
      clientId: record.descriptor.clientId,
      secretRef: record.descriptor.clientAuthentication.secretRef,
      accountId: record.account.userId,
    };
    const read = async (request: GithubActionsSourceRead): Promise<GithubActionsSourceResult> => {
      if (!current()) return { kind: "refused", reason: "connection-unavailable" };
      try {
        const result = await this.#credentialStage(() => readSource(request));
        if (!current()) return { kind: "refused", reason: "connection-unavailable" };
        const decoded = decodeGithubActionsSourceResult(result) ?? {
          kind: "refused" as const,
          reason: "source-unavailable" as const,
        };
        if (
          decoded.kind === "refused" &&
          (decoded.reason === "account-changed" ||
            decoded.reason === "repository-changed" ||
            decoded.reason === "permission-denied")
        )
          live = false;
        return decoded;
      } catch {
        return { kind: "refused", reason: "connection-unavailable" };
      }
    };
    const prepared = await read({
      ...owner,
      kind: "repository",
      owner: selected.owner,
      name: selected.name,
    });
    if (
      prepared.kind !== "repository" ||
      !current() ||
      prepared.accountId !== owner.accountId ||
      (selected.expected !== undefined &&
        (prepared.repository.id !== selected.expected.id ||
          prepared.repository.nodeId !== selected.expected.nodeId ||
          prepared.repository.owner.toLowerCase() !== selected.expected.owner.toLowerCase() ||
          prepared.repository.name.toLowerCase() !== selected.expected.name.toLowerCase()))
    )
      return undefined;
    const repository = Object.freeze({ ...prepared.repository });
    return Object.freeze({
      current,
      accountId: owner.accountId,
      repository,
      runs: (input?: Parameters<GithubActionsSource["runs"]>[0]) =>
        read({
          ...owner,
          kind: "runs",
          repository,
          page: input?.page ?? 1,
          ...(input?.workflowId === undefined ? {} : { workflowId: input.workflowId }),
          ...(input?.branch === undefined ? {} : { branch: input.branch }),
        }),
    });
  }

  /** Captures this exact grant owner and a digest, never a reusable caller-selected ref. */
  async bindAuthentication(
    extensionId: string,
    componentId: string,
    launch: AgentPluginsMcpLaunchSpec,
  ): Promise<
    | {
        readonly check: () => Promise<"unchanged" | "changed" | "unavailable">;
        readonly rejected: () => Promise<void>;
      }
    | undefined
  > {
    await this.#load();
    if (launch.transport === "stdio") return undefined;
    const key = signInKey(extensionId, componentId);
    const record = this.#signIns.get(key);
    if (record === undefined) return undefined;
    const expected = authorizationDigest(new Headers(launch.headers).get("authorization") ?? "");
    return {
      check: async () => {
        if (!this.#currentGrant(key, record) || !recordAdmitsTransport(record, launch.url))
          return "changed";
        const answer = await this.#currentAccess(key, record);
        if (!this.#currentGrant(key, record)) return "changed";
        if (isRecord(answer) && answer.kind === "sign-in-again") {
          await this.#markSignInAgain(key, record, answer.reason, extensionId, componentId);
          return "changed";
        }
        if (
          !isRecord(answer) ||
          answer.kind !== "granted" ||
          typeof answer.accessToken !== "string"
        )
          return "unavailable";
        const tokenType = typeof answer.tokenType === "string" ? answer.tokenType : "Bearer";
        if (
          (record.descriptor.dialect === SLACK_MCP_USER_OAUTH.dialect ||
            record.descriptor.dialect === GITHUB_MCP_OAUTH_APP.dialect) &&
          tokenType.toLowerCase() !== "bearer"
        )
          return "unavailable";
        return authorizationDigest(`${tokenType} ${answer.accessToken}`) === expected
          ? "unchanged"
          : "changed";
      },
      rejected: async () => {
        await this.#commit(async () => {
          if (!this.#currentGrant(key, record)) return;
          const current = this.#signIns.get(key);
          if (current === undefined) return;
          this.#signIns.set(key, { ...current, refreshRequired: true });
          await this.#persist();
        });
      },
    };
  }

  #currentGrant(key: string, record: McpServerSignInRecord): boolean {
    const current = this.#signIns.get(key);
    return (
      current !== undefined &&
      current.credentialRef === record.credentialRef &&
      current.descriptor === record.descriptor &&
      !current.signOutPending &&
      current.signInAgain === undefined
    );
  }

  async #credentialStage<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Credential access timed out.")),
            REQUEST_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #currentAccess(key: string, record: McpServerSignInRecord): Promise<unknown> {
    if (!this.#currentGrant(key, record)) return { kind: "unavailable" };
    try {
      let answer = await this.#credentialStage(() => this.#options.access(record.credentialRef));
      if (!this.#currentGrant(key, record)) return { kind: "unavailable" };
      if (!isRecord(answer) || answer.kind !== "granted") return answer;
      answer = await this.#observeAccount(key, record, answer);
      if (!isRecord(answer) || answer.kind !== "granted") return answer;
      const expiry = accessExpiry(answer);
      if (expiry === "invalid") return { kind: "unavailable" };
      if (
        this.#signIns.get(key)?.refreshRequired ||
        (expiry !== undefined && expiry <= (this.#options.now?.().getTime() ?? Date.now()))
      ) {
        const refresh = this.#options.refresh;
        if (refresh === undefined) return { kind: "unavailable" };
        const refreshed = await this.#credentialStage(() => refresh(record.credentialRef));
        if (!this.#currentGrant(key, record)) return { kind: "unavailable" };
        if (!isRecord(refreshed) || refreshed.kind !== "refreshed") return refreshed;
        answer = await this.#credentialStage(() => this.#options.access(record.credentialRef));
        if (!this.#currentGrant(key, record)) return { kind: "unavailable" };
        if (!isRecord(answer) || answer.kind !== "granted") return answer;
        answer = await this.#observeAccount(key, record, answer);
        if (!isRecord(answer) || answer.kind !== "granted") return answer;
        const currentExpiry = accessExpiry(answer);
        if (
          currentExpiry === "invalid" ||
          (currentExpiry !== undefined &&
            currentExpiry <= (this.#options.now?.().getTime() ?? Date.now()))
        )
          return { kind: "unavailable" };
        await this.#commit(async () => {
          if (!this.#currentGrant(key, record)) return;
          const current = this.#signIns.get(key);
          if (current?.refreshRequired !== true) return;
          const { refreshRequired: _required, ...clean } = current;
          this.#signIns.set(key, clean);
          try {
            await this.#persist();
          } catch (error) {
            this.#signIns.set(key, current);
            throw error;
          }
        });
      }
      return this.#currentGrant(key, record) ? answer : { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async #observeAccount(
    key: string,
    record: McpServerSignInRecord,
    answer: Record<string, unknown>,
  ): Promise<unknown> {
    if (
      record.descriptor.dialect === GITHUB_MCP_OAUTH_APP.dialect &&
      answer.mcpPermissionProfile !== record.descriptor.mcpPermissionProfile
    )
      return { kind: "sign-in-again", reason: "permission-mismatch" };
    if (
      record.descriptor.dialect === GITHUB_MCP_OAUTH_APP.dialect &&
      answer.mcpAccount === undefined
    )
      return { kind: "unavailable" };
    if (
      (record.descriptor.dialect !== SLACK_MCP_USER_OAUTH.dialect &&
        record.descriptor.dialect !== GITHUB_MCP_OAUTH_APP.dialect) ||
      answer.mcpAccount === undefined
    )
      return answer;
    const current = this.#signIns.get(key);
    if (!this.#currentGrant(key, record) || current === undefined) return { kind: "unavailable" };
    const initial = inspectReportedAccount(current.account, answer.mcpAccount, record.descriptor);
    if (initial.kind !== "valid")
      return initial.kind === "invalid"
        ? { kind: "unavailable" }
        : { kind: "sign-in-again", reason: initial.kind };
    if (JSON.stringify(initial.account) === JSON.stringify(current.account)) return answer;
    return this.#commit(async () => {
      if (!this.#currentGrant(key, record)) return { kind: "unavailable" };
      const owner = this.#signIns.get(key);
      if (owner === undefined) return { kind: "unavailable" };
      const observed = inspectReportedAccount(owner.account, answer.mcpAccount, record.descriptor);
      if (observed.kind !== "valid")
        return observed.kind === "invalid"
          ? { kind: "unavailable" }
          : { kind: "sign-in-again", reason: observed.kind };
      const updated = { ...owner, account: observed.account };
      this.#signIns.set(key, updated);
      try {
        await this.#persist();
      } catch (error) {
        this.#signIns.set(key, owner);
        throw error;
      }
      return answer;
    });
  }

  async #markSignInAgain(
    key: string,
    record: McpServerSignInRecord,
    value: unknown,
    extensionId: string,
    componentId: string,
  ): Promise<void> {
    const reason = signInAgainReason(value);
    if (reason === undefined) return;
    let changed = false;
    try {
      await this.#commit(async () => {
        if (!this.#currentGrant(key, record)) return;
        const owner = this.#signIns.get(key);
        if (owner === undefined) return;
        this.#signIns.set(key, { ...owner, signInAgain: reason });
        changed = true;
        await this.#persist();
      });
    } finally {
      if (changed) await this.#options.onAuthenticationChanged?.(extensionId, componentId);
    }
  }

  /**
   * Attaches the signed-in bearer to a launch, when there is one. A sign-in
   * whose grant the broker says is gone (revoked, expired, refresh reused) is
   * marked so Settings shows Sign in again; the launch goes out bare and the
   * server answers 401. A broker that is merely unavailable changes nothing.
   */
  async #attachBearer(
    extensionId: string,
    componentId: string,
    launch: AgentPluginsMcpLaunchSpec,
  ): Promise<AgentPluginsMcpLaunchSpec> {
    await this.#load();
    if (launch.transport === "stdio") return launch;
    const key = signInKey(extensionId, componentId);
    const record = this.#signIns.get(key);
    if (record === undefined || record.signOutPending || record.signInAgain !== undefined)
      return launch;
    if (!recordAdmitsTransport(record, launch.url)) return launch;
    const answer = await this.#currentAccess(key, record);
    if (!isRecord(answer) || !this.#currentGrant(key, record)) return launch;
    if (answer.kind === "sign-in-again") {
      await this.#markSignInAgain(key, record, answer.reason, extensionId, componentId);
      return launch;
    }
    if (answer.kind !== "granted" || typeof answer.accessToken !== "string") return launch;
    const tokenType = typeof answer.tokenType === "string" ? answer.tokenType : "Bearer";
    if (
      (record.descriptor.dialect === SLACK_MCP_USER_OAUTH.dialect ||
        record.descriptor.dialect === GITHUB_MCP_OAUTH_APP.dialect) &&
      tokenType.toLowerCase() !== "bearer"
    )
      return launch;
    return {
      ...launch,
      headers: { ...launch.headers, Authorization: `${tokenType} ${answer.accessToken}` },
    };
  }

  async #readServerPolicy(
    extensionId: string,
    componentId: string,
    url: string,
  ): Promise<GeneratedMcpSignInPolicy | undefined> {
    if (this.#options.serverPolicy === undefined) return { url, current: () => true };
    try {
      const policy = await this.#credentialStage(
        () => this.#options.serverPolicy?.(extensionId, componentId) ?? Promise.resolve(undefined),
      );
      return policy !== undefined &&
        policy.current() &&
        canonicalResource(policy.url) === canonicalResource(url) &&
        (policy.mcpPermissionProfile === undefined ||
          canonicalResource(url) === GITHUB_MCP_OAUTH_APP.transportUrl)
        ? policy
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #discover(
    serverUrl: string,
    mcpPermissionProfile?: GithubMcpPermissionProfile,
  ): Promise<Discovered> {
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
    // RFC 9728 §3.3: the metadata must name this very server. Accepting
    // another resource would let a server obtain a bearer meant for a
    // different API and then receive it on connect.
    const transportUrl = canonicalResource(serverUrl);
    const resource = mcpOAuthResourceForTransport(transportUrl);
    const googleScopes = googleWorkspaceMcpScopes(resource);
    // Google's resource metadata names the root issuer with a slash while its
    // OpenID document names the same root without it. No other issuer is normalized.
    const canonicalIssuer =
      googleScopes !== undefined && issuer === `${GOOGLE_WORKSPACE_MCP_OAUTH.issuer}/`
        ? GOOGLE_WORKSPACE_MCP_OAUTH.issuer
        : issuer;
    if (
      typeof metadata.resource !== "string" ||
      !isAbsoluteUrl(metadata.resource) ||
      canonicalResource(metadata.resource) !== resource
    ) {
      return {
        kind: "issuer-unsupported",
        message: "The server's metadata names a different resource than its own address.",
      };
    }
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
      // RFC 8414 §3.3: the document must name the issuer it was fetched for,
      // or its endpoints may belong to another tenant (issuer mix-up).
      issuerMetadata.issuer !== canonicalIssuer ||
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
    const googleAdvertisedScopes = metadata.scopes_supported;
    if (
      googleScopes !== undefined &&
      (canonicalIssuer !== GOOGLE_WORKSPACE_MCP_OAUTH.issuer ||
        authorizationEndpoint !== GOOGLE_WORKSPACE_MCP_OAUTH.authorizationEndpoint ||
        tokenEndpoint !== GOOGLE_WORKSPACE_MCP_OAUTH.tokenEndpoint ||
        !Array.isArray(methods) ||
        !methods.includes("S256") ||
        !Array.isArray(googleAdvertisedScopes) ||
        !googleScopes.every((scope) => googleAdvertisedScopes.includes(scope)))
    )
      return {
        kind: "issuer-unsupported",
        message:
          "Google Workspace metadata does not support the selected read-only native-client connection.",
      };
    const slack = transportUrl === SLACK_MCP_USER_OAUTH.transportUrl;
    const reserved =
      slack ||
      new URL(transportUrl).origin === SLACK_MCP_USER_OAUTH.resource ||
      issuer === SLACK_MCP_USER_OAUTH.issuer ||
      authorizationEndpoint === SLACK_MCP_USER_OAUTH.authorizationEndpoint ||
      tokenEndpoint === SLACK_MCP_USER_OAUTH.tokenEndpoint;
    if (
      reserved &&
      (!slack ||
        resource !== SLACK_MCP_USER_OAUTH.resource ||
        issuer !== SLACK_MCP_USER_OAUTH.issuer ||
        authorizationEndpoint !== SLACK_MCP_USER_OAUTH.authorizationEndpoint ||
        tokenEndpoint !== SLACK_MCP_USER_OAUTH.tokenEndpoint)
    )
      return {
        kind: "issuer-unsupported",
        message:
          "The server's authorization metadata does not match its reviewed resource, issuer and endpoints.",
      };
    if (
      slack &&
      (!Array.isArray(metadata.scopes_supported) ||
        !metadata.scopes_supported.includes(SLACK_MCP_USER_OAUTH.readScope))
    )
      return {
        kind: "issuer-unsupported",
        message: "The server does not advertise the selected read permission.",
      };
    const github = transportUrl === GITHUB_MCP_OAUTH_APP.transportUrl;
    const githubReserved =
      github ||
      new URL(transportUrl).hostname === "api.githubcopilot.com" ||
      issuer === GITHUB_MCP_OAUTH_APP.issuer ||
      authorizationEndpoint === GITHUB_MCP_OAUTH_APP.authorizationEndpoint ||
      tokenEndpoint === GITHUB_MCP_OAUTH_APP.tokenEndpoint;
    const resourceScopes = metadata.scopes_supported;
    if (
      githubReserved &&
      (!github ||
        resource !== GITHUB_MCP_OAUTH_APP.resource ||
        issuer !== GITHUB_MCP_OAUTH_APP.issuer ||
        authorizationEndpoint !== GITHUB_MCP_OAUTH_APP.authorizationEndpoint ||
        tokenEndpoint !== GITHUB_MCP_OAUTH_APP.tokenEndpoint ||
        !Array.isArray(methods) ||
        !methods.includes("S256") ||
        issuerMetadata.authorization_response_iss_parameter_supported !== true ||
        !Array.isArray(resourceScopes) ||
        !githubMcpRequiredScopes(mcpPermissionProfile).every((scope) =>
          resourceScopes.includes(scope),
        ) ||
        !Array.isArray(issuerMetadata.scopes_supported) ||
        !issuerMetadata.scopes_supported.includes(GITHUB_MCP_OAUTH_APP.rotationScope) ||
        (issuerMetadata.token_endpoint_auth_methods_supported !== undefined &&
          (!Array.isArray(issuerMetadata.token_endpoint_auth_methods_supported) ||
            !issuerMetadata.token_endpoint_auth_methods_supported.includes("client_secret_post"))))
    )
      return {
        kind: "issuer-unsupported",
        message:
          "GitHub authorization metadata does not support the selected OAuth App permission profile.",
      };
    const registration = issuerMetadata.registration_endpoint;
    const scopes =
      googleScopes !== undefined
        ? [...googleScopes]
        : github
          ? [...githubMcpRequiredScopes(mcpPermissionProfile), GITHUB_MCP_OAUTH_APP.rotationScope]
          : slack
            ? [SLACK_MCP_USER_OAUTH.readScope]
            : Array.isArray(metadata.scopes_supported)
              ? metadata.scopes_supported
                  .filter((entry): entry is string => typeof entry === "string")
                  .filter((entry) => SCOPE_TOKEN_PATTERN.test(entry))
                  .slice(0, 16)
              : [];
    return {
      kind: "discovered",
      resource,
      transportUrl,
      mcpDialect: github
        ? GITHUB_MCP_OAUTH_APP.dialect
        : slack
          ? SLACK_MCP_USER_OAUTH.dialect
          : "mcp-authorization",
      issuer: issuerUrl.host,
      issuerUrl: canonicalIssuer,
      metadataClientSupported:
        googleScopes === undefined &&
        !github &&
        issuerMetadata.client_id_metadata_document_supported === true,
      tokenAuthenticationMethods:
        googleScopes !== undefined
          ? ["none"]
          : github
            ? ["client_secret_post"]
            : Array.isArray(issuerMetadata.token_endpoint_auth_methods_supported)
              ? issuerMetadata.token_endpoint_auth_methods_supported.filter(
                  (entry): entry is string => typeof entry === "string",
                )
              : ["client_secret_basic"],
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint:
        googleScopes === undefined &&
        !github &&
        typeof registration === "string" &&
        isHttps(registration)
          ? registration
          : undefined,
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

  #load(): Promise<void> {
    this.#loading ??= this.#readState();
    return this.#loading;
  }

  async #readState(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#options.statePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as PersistedSignIns;
      if (parsed.schemaVersion !== 1 || !isRecord(parsed.signIns)) return;
      for (const reference of parsed.retiredClientSecrets ?? []) {
        if (typeof reference === "string" && UUID_PATTERN.test(reference)) {
          this.#retiredClientSecrets.add(reference);
          this.#retirementStarted.add(reference);
        }
      }
      for (const [key, port] of Object.entries(parsed.callbackPorts ?? {})) {
        if (Number.isInteger(port) && port >= 1024 && port <= 65535)
          this.#callbackPorts.set(key, port);
      }
      for (const [key, registration] of Object.entries(parsed.registrations ?? {})) {
        try {
          this.#registrations.set(key, decodeMcpOAuthClientRegistration(registration));
        } catch {
          /* Invalid setup cannot start consent. */
        }
      }
      for (const [key, record] of Object.entries(parsed.signIns)) {
        if (isRecord(record) && typeof record.credentialRef === "string") {
          const stored = record as McpServerSignInRecord;
          const { account: supplied, ...owner } = stored;
          if (
            stored.descriptor?.dialect === GITHUB_MCP_OAUTH_APP.dialect &&
            !isGithubMcpDescriptorBinding(stored.descriptor)
          ) {
            this.#signIns.set(key, { ...owner, signInAgain: "permission-mismatch" });
            continue;
          }
          if (
            (stored.descriptor?.dialect === SLACK_MCP_USER_OAUTH.dialect ||
              stored.descriptor?.dialect === GITHUB_MCP_OAUTH_APP.dialect) &&
            supplied !== undefined
          ) {
            try {
              const observed = inspectReportedAccount(undefined, supplied, stored.descriptor);
              if (observed.kind !== "valid") {
                this.#signIns.set(key, {
                  ...owner,
                  signInAgain: observed.kind === "invalid" ? "account-changed" : observed.kind,
                });
              } else this.#signIns.set(key, { ...owner, account: observed.account });
            } catch {
              this.#signIns.set(key, { ...owner, signInAgain: "account-changed" });
            }
          } else this.#signIns.set(key, owner);
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
      registrations: Object.fromEntries(this.#registrations),
      callbackPorts: Object.fromEntries(this.#callbackPorts),
      retiredClientSecrets: Array.from(this.#retiredClientSecrets),
    };
    await mkdir(dirname(this.#options.statePath), { recursive: true, mode: 0o700 });
    const contents = JSON.stringify(payload);
    if (this.#options.replaceState !== undefined) {
      await this.#options.replaceState(this.#options.statePath, contents);
      return;
    }
    const staging = `${this.#options.statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(staging, contents, { mode: 0o600, flag: "wx" });
      await rename(staging, this.#options.statePath);
    } finally {
      await rm(staging, { force: true });
    }
  }
}

function signInKey(extensionId: string, componentId: string): string {
  return `${extensionId}:${componentId}`;
}

function refused(
  reason: Extract<McpServerSignInView, { kind: "refused" }>["reason"],
  message: string,
): Extract<McpServerSignInView, { kind: "refused" }> {
  return { kind: "refused", reason, message };
}

function recordView(record: McpServerSignInRecord): McpServerSignInView {
  if (record.signOutPending) return signOutPending();
  return record.signInAgain === undefined
    ? {
        kind: "signed-in",
        issuer: record.issuer,
        ...(record.account === undefined ? {} : { account: record.account }),
      }
    : { kind: "sign-in-again", reason: record.signInAgain };
}

/**
 * An MCP server's sign-in ends or is revoked; only the organization directory
 * dialect asks for a person to be present again, so that reason never applies.
 */
type McpSignInAgainReason = Exclude<HostOAuthSignInAgainReason, "interaction-required">;

function signInAgainReason(value: unknown): McpSignInAgainReason | undefined {
  return value === "revoked" ||
    value === "expired" ||
    value === "refresh-reused" ||
    value === "account-changed" ||
    value === "permission-missing" ||
    value === "permission-mismatch" ||
    value === "identity-unavailable"
    ? value
    : undefined;
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
      // Never sent for an MCP grant; read as an ended sign-in if it were.
      return {
        kind: "sign-in-again",
        reason: state.reason === "interaction-required" ? "expired" : state.reason,
      };
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

function cancellationPending(): Extract<McpServerSignInView, { readonly kind: "cancel-pending" }> {
  return {
    kind: "cancel-pending",
    message:
      "Sign-in cancellation is not confirmed. Restore the credential broker and try Cancel sign-in again.",
  };
}

function statusUnavailable(): Extract<
  McpServerSignInView,
  { readonly kind: "status-unavailable" }
> {
  return {
    kind: "status-unavailable",
    message:
      "Sign-in status is unavailable. Restore the credential broker, then check sign-in or cancel this attempt.",
  };
}

function signOutPending(): Extract<McpServerSignInView, { readonly kind: "sign-out-pending" }> {
  return {
    kind: "sign-out-pending",
    message:
      "Sign-out is not confirmed. Restore the credential broker, then finish signing out. This connection cannot be used meanwhile.",
  };
}

function authorizationDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function accessExpiry(answer: Record<string, unknown>): number | "invalid" | undefined {
  if (answer.expiresAt === undefined) return undefined;
  if (typeof answer.expiresAt !== "string") return "invalid";
  const expiry = Date.parse(answer.expiresAt);
  return Number.isFinite(expiry) ? expiry : "invalid";
}
function recordAdmitsTransport(record: McpServerSignInRecord, url: string): boolean {
  const transportUrl = canonicalResource(url);
  return record.descriptor.dialect === GITHUB_MCP_OAUTH_APP.dialect
    ? isGithubMcpDescriptorBinding(record.descriptor) &&
        transportUrl === GITHUB_MCP_OAUTH_APP.transportUrl
    : record.descriptor.dialect === SLACK_MCP_USER_OAUTH.dialect
      ? isSlackMcpUserDescriptorBinding(record.descriptor) &&
        transportUrl === SLACK_MCP_USER_OAUTH.transportUrl
      : record.descriptor.resource === transportUrl &&
        transportUrl !== SLACK_MCP_USER_OAUTH.transportUrl &&
        transportUrl !== GITHUB_MCP_OAUTH_APP.transportUrl;
}

function slackRegistrationReady(registration: McpOAuthClientRegistration | undefined): boolean {
  return (
    registration?.kind === "registered" &&
    registration.resource === SLACK_MCP_USER_OAUTH.resource &&
    registration.issuer === SLACK_MCP_USER_OAUTH.issuer &&
    registration.redirectHostname === "localhost" &&
    registration.clientAuthentication?.method === "client_secret_post" &&
    registration.clientAuthentication.tokenEndpoint === SLACK_MCP_USER_OAUTH.tokenEndpoint
  );
}
function githubRegistrationReady(registration: McpOAuthClientRegistration | undefined): boolean {
  return (
    registration?.kind === "registered" &&
    registration.resource === GITHUB_MCP_OAUTH_APP.resource &&
    registration.issuer === GITHUB_MCP_OAUTH_APP.issuer &&
    registration.redirectHostname === undefined &&
    registration.clientAuthentication?.method === "client_secret_post" &&
    registration.clientAuthentication.tokenEndpoint === GITHUB_MCP_OAUTH_APP.tokenEndpoint
  );
}
function inspectReportedAccount(
  previous: McpReportedAccount | undefined,
  value: unknown,
  descriptor: Pick<HostOAuthDescriptor, "dialect" | "mcpPermissionProfile">,
):
  | { readonly kind: "valid"; readonly account: McpReportedAccount }
  | {
      readonly kind: "invalid" | "account-changed" | "permission-missing" | "permission-mismatch";
    } {
  let reported: McpReportedAccount;
  try {
    reported = decodeMcpReportedAccount(value);
  } catch {
    return { kind: "invalid" };
  }
  if (descriptor.dialect === GITHUB_MCP_OAUTH_APP.dialect) {
    const expected = githubMcpRequiredScopes(descriptor.mcpPermissionProfile);
    const reportedScopes = reported.grantedScopes;
    if (reported.workspaceId !== undefined || reported.userId === undefined)
      return { kind: "invalid" };
    if (reportedScopes?.some((scope) => !expected.includes(scope)))
      return { kind: "permission-mismatch" };
    if (reportedScopes !== undefined && !expected.every((scope) => reportedScopes.includes(scope)))
      return { kind: "permission-missing" };
    const account = decodeGithubMcpAccount(
      { ...previous, ...reported },
      descriptor.mcpPermissionProfile,
    );
    if (account === undefined) return { kind: "invalid" };
    if (previous?.userId !== undefined && previous.userId !== account.userId)
      return { kind: "account-changed" };
    return { kind: "valid", account: decodeMcpReportedAccount(account) };
  }
  if (
    (previous?.workspaceId !== undefined &&
      reported.workspaceId !== undefined &&
      previous.workspaceId !== reported.workspaceId) ||
    (previous?.userId !== undefined &&
      reported.userId !== undefined &&
      previous.userId !== reported.userId)
  )
    return { kind: "account-changed" };
  if (
    reported.grantedScopes !== undefined &&
    !reported.grantedScopes.includes(SLACK_MCP_USER_OAUTH.readScope)
  )
    return { kind: "permission-missing" };
  return { kind: "valid", account: { ...previous, ...reported } };
}
