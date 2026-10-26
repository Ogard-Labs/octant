const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HostOAuthBrokerDescriptor {
  readonly descriptorId: string;
  readonly clientId?: string;
  readonly dialect?:
    | "openrouter-pkce"
    | "chatgpt-plan-siwc"
    | "mcp-authorization"
    | "directory-oidc"
    | "issuer-oidc";
  readonly flow: "authorization-code-pkce" | "device-code";
  readonly authorizationEndpoint?: string;
  /** Absent only for the directory dialect, whose authority the broker builds. */
  readonly tokenEndpoint?: string;
  readonly deviceAuthorizationEndpoint?: string;
  readonly scopes: readonly string[];
  readonly termsId: string;
  /** ChatGPT plan dialect: the stable host id sent as `ext_agent_host_id`. */
  readonly extAgentHostId?: string;
  /** ChatGPT plan dialect: the app name sent as `agent_name_hint` on registration. */
  readonly agentNameHint?: string;
  /** MCP authorization dialect: the server the token is for, and the callback port. */
  readonly resource?: string;
  readonly redirectPort?: number;
  /** Directory dialect: the tenant, the one audience, and the endpoint origin the grant binds. */
  readonly tenantId?: string;
  readonly audience?: string;
  readonly endpointOrigin?: string;
  /** Issuer dialect: the organization's own issuer; its one scope is the gateway's. */
  readonly issuer?: string;
}

/**
 * What a directory or issuer grant was signed in for; its token is released
 * only under this binding.
 */
export type HostOAuthBrokerBinding =
  | {
      readonly tenantId: string;
      readonly clientId: string;
      readonly audience: string;
      readonly endpointOrigin: string;
    }
  | {
      readonly issuer: string;
      readonly clientId: string;
      readonly scope: string;
      readonly endpointOrigin: string;
    };

export interface HostOAuthBrokerPort {
  readonly begin: (input: {
    readonly descriptor: HostOAuthBrokerDescriptor;
    readonly actorId: string;
    readonly termsAcknowledgedAt: string;
    /** ChatGPT plan reauthorization: the instance's stored grant. Optional. */
    readonly credentialRef?: string;
  }) => Promise<unknown>;
  readonly status: (attemptId: string) => Promise<unknown>;
  readonly refresh: (credentialRef: string) => Promise<unknown>;
  /**
   * A directory grant releases its token only to a caller naming its exact
   * binding; a grant of any other kind refuses one.
   */
  readonly access: (credentialRef: string, binding?: HostOAuthBrokerBinding) => Promise<unknown>;
  /**
   * Revoke a grant: the ChatGPT plan dialect revokes the refresh token at
   * the issuer's revocation endpoint before the local grant is dropped.
   */
  readonly revoke: (credentialRef: string) => Promise<unknown>;
  readonly forget: (credentialRef: string) => Promise<void>;
}

export function makeHostOAuthBrokerClient(options: {
  readonly url: string;
  readonly token: string;
  /**
   * Injectable fetch. A call signature, not `typeof fetch`: Bun's fetch
   * carries extra methods a test double does not, and the client only calls it.
   */
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): HostOAuthBrokerPort {
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
    if (!response.ok) throw new Error("Octant host OAuth broker refused the request.");
    const value: unknown = await response.json();
    return value;
  };

  const client: HostOAuthBrokerPort = {
    begin: (input) => {
      if (!UUID_PATTERN.test(input.actorId)) {
        return Promise.reject(new Error("Octant host OAuth broker refused the request."));
      }
      if (input.credentialRef !== undefined && !UUID_PATTERN.test(input.credentialRef)) {
        return Promise.reject(new Error("Octant host OAuth broker refused the request."));
      }
      return post("/v1/oauth/begin", {
        actorId: input.actorId,
        termsAcknowledgedAt: input.termsAcknowledgedAt,
        ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
        descriptor: {
          descriptorId: input.descriptor.descriptorId,
          ...(input.descriptor.clientId === undefined
            ? {}
            : { clientId: input.descriptor.clientId }),
          ...(input.descriptor.dialect === undefined ? {} : { dialect: input.descriptor.dialect }),
          flow: input.descriptor.flow,
          ...(input.descriptor.tokenEndpoint === undefined
            ? {}
            : { tokenEndpoint: input.descriptor.tokenEndpoint }),
          scopes: input.descriptor.scopes,
          termsId: input.descriptor.termsId,
          ...(input.descriptor.authorizationEndpoint === undefined
            ? {}
            : { authorizationEndpoint: input.descriptor.authorizationEndpoint }),
          ...(input.descriptor.deviceAuthorizationEndpoint === undefined
            ? {}
            : { deviceAuthorizationEndpoint: input.descriptor.deviceAuthorizationEndpoint }),
          ...(input.descriptor.extAgentHostId === undefined
            ? {}
            : { extAgentHostId: input.descriptor.extAgentHostId }),
          ...(input.descriptor.agentNameHint === undefined
            ? {}
            : { agentNameHint: input.descriptor.agentNameHint }),
          ...(input.descriptor.resource === undefined
            ? {}
            : { resource: input.descriptor.resource }),
          ...(input.descriptor.redirectPort === undefined
            ? {}
            : { redirectPort: input.descriptor.redirectPort }),
          ...(input.descriptor.tenantId === undefined
            ? {}
            : { tenantId: input.descriptor.tenantId }),
          ...(input.descriptor.audience === undefined
            ? {}
            : { audience: input.descriptor.audience }),
          ...(input.descriptor.endpointOrigin === undefined
            ? {}
            : { endpointOrigin: input.descriptor.endpointOrigin }),
        },
      });
    },
    status: (attemptId) => {
      if (!UUID_PATTERN.test(attemptId)) {
        return Promise.reject(new Error("Octant host OAuth broker refused the request."));
      }
      return post("/v1/oauth/status", { attemptId });
    },
    refresh: (credentialRef) => {
      if (!UUID_PATTERN.test(credentialRef)) {
        return Promise.reject(new Error("Octant host OAuth broker refused the request."));
      }
      return post("/v1/oauth/refresh", { credentialRef });
    },
    access: (credentialRef, binding) => {
      if (!UUID_PATTERN.test(credentialRef)) {
        return Promise.reject(new Error("Octant host OAuth broker refused the request."));
      }
      // Exactly one kind's four binding fields: the broker refuses any other shape.
      return post(
        "/v1/oauth/access",
        binding === undefined
          ? { credentialRef }
          : {
              credentialRef,
              binding:
                "tenantId" in binding
                  ? {
                      tenantId: binding.tenantId,
                      clientId: binding.clientId,
                      audience: binding.audience,
                      endpointOrigin: binding.endpointOrigin,
                    }
                  : {
                      issuer: binding.issuer,
                      clientId: binding.clientId,
                      scope: binding.scope,
                      endpointOrigin: binding.endpointOrigin,
                    },
            },
      );
    },
    revoke: (credentialRef) => {
      if (!UUID_PATTERN.test(credentialRef)) {
        return Promise.reject(new Error("Octant host OAuth broker refused the request."));
      }
      return post("/v1/oauth/revoke", { credentialRef });
    },
    forget: async (credentialRef) => {
      if (!UUID_PATTERN.test(credentialRef)) {
        throw new Error("Octant host OAuth broker refused the request.");
      }
      const response = await fetchImpl(new URL("/v1/credentials/delete", options.url), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-octant-credential-broker-token": options.token,
        },
        body: JSON.stringify({ providerInstanceId: credentialRef }),
      });
      if (response.status === 404) return;
      if (!response.ok) throw new Error("Octant host OAuth broker refused the request.");
    },
  };
  return client;
}
