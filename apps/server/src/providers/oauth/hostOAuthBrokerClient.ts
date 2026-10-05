const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HostOAuthBrokerPort {
  readonly begin: (input: {
    readonly descriptor: {
      readonly descriptorId: string;
      readonly clientId: string;
      readonly flow: "authorization-code-pkce" | "device-code";
      readonly authorizationEndpoint?: string;
      readonly tokenEndpoint: string;
      readonly deviceAuthorizationEndpoint?: string;
      readonly scopes: readonly string[];
      readonly termsId: string;
    };
    readonly actorId: string;
    readonly termsAcknowledgedAt: string;
  }) => Promise<unknown>;
  readonly status: (attemptId: string) => Promise<unknown>;
  readonly refresh: (credentialRef: string) => Promise<unknown>;
  readonly access: (credentialRef: string) => Promise<unknown>;
  readonly forget: (credentialRef: string) => Promise<void>;
}

export function makeHostOAuthBrokerClient(options: {
  readonly url: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
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
      return post("/v1/oauth/begin", {
        actorId: input.actorId,
        termsAcknowledgedAt: input.termsAcknowledgedAt,
        descriptor: {
          descriptorId: input.descriptor.descriptorId,
          clientId: input.descriptor.clientId,
          flow: input.descriptor.flow,
          tokenEndpoint: input.descriptor.tokenEndpoint,
          scopes: input.descriptor.scopes,
          termsId: input.descriptor.termsId,
          ...(input.descriptor.authorizationEndpoint === undefined
            ? {}
            : { authorizationEndpoint: input.descriptor.authorizationEndpoint }),
          ...(input.descriptor.deviceAuthorizationEndpoint === undefined
            ? {}
            : { deviceAuthorizationEndpoint: input.descriptor.deviceAuthorizationEndpoint }),
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
    access: (credentialRef) => {
      if (!UUID_PATTERN.test(credentialRef)) {
        return Promise.reject(new Error("Octant host OAuth broker refused the request."));
      }
      return post("/v1/oauth/access", { credentialRef });
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
