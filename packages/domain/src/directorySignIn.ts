import type { DirectoryBinding, DirectoryIssuerBinding } from "@octant/contracts";
import type { HostOAuthDescriptor } from "@octant/contracts/host-oauth";

/**
 * Organization (directory) sign-in for Azure AI Foundry, as product data the
 * server, the driver, and Settings share. The audience and the host list are
 * the driver kind's own: configuration cannot name another resource or send a
 * directory bearer to another host.
 */
export const AZURE_FOUNDRY_DIRECTORY_SIGN_IN = {
  descriptorId: "azure-foundry-directory",
  termsId: "azure-foundry-directory-1",
  /** Shown until the directory names the account. */
  accountLabel: "Organization account",
  termsSummary:
    "Octant signs you in with your organization's Microsoft Entra ID account and keeps the sign-in in this computer's credential broker. Requests to this Azure AI Foundry endpoint run as you, under your organization's policies. Sign out removes this computer's sign-in only; it does not end your organization session.",
  /**
   * Printed beside a device code by the host-local command. A device code is
   * the easier sign-in to phish: someone who sends a person their own code
   * gets a sign-in as that person when it is entered.
   */
  deviceCodeWarning:
    "Enter this code only because you just ran this command on this computer. Never enter a sign-in code someone sent you.",
  /** The resource Azure AI Foundry's OpenAI v1 endpoints accept a token for. */
  audience: "https://cognitiveservices.azure.com",
  /** The hosts Azure AI Foundry serves its OpenAI v1 API under. */
  hostSuffixes: [".openai.azure.com", ".services.ai.azure.com", ".cognitiveservices.azure.com"],
} as const;

/** Whether an address is https, carries no credentials, and lies under the Foundry host list. */
export function isAzureFoundryDirectoryHost(baseUrl: string): boolean {
  return azureFoundryDirectoryOrigin(baseUrl) !== undefined;
}

/** The https origin a directory grant binds to, or undefined off the host list. */
export function azureFoundryDirectoryOrigin(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  const host = url.hostname.toLowerCase();
  return AZURE_FOUNDRY_DIRECTORY_SIGN_IN.hostSuffixes.some((suffix) => host.endsWith(suffix))
    ? url.origin
    : undefined;
}

/**
 * The broker descriptor a sign-in for this instance begins with, built from
 * its configuration alone; undefined when the address is off the host list.
 * The flow is the loopback redirect unless the caller asks for a device code;
 * whether the instance allows one is the server's check, not this one's.
 */
export function azureFoundryDirectoryDescriptor(
  configuration: {
    readonly baseUrl: string;
    readonly directory: DirectoryBinding;
  },
  flow: HostOAuthDescriptor["flow"] = "authorization-code-pkce",
): HostOAuthDescriptor | undefined {
  const endpointOrigin = azureFoundryDirectoryOrigin(configuration.baseUrl);
  if (endpointOrigin === undefined) return undefined;
  return {
    descriptorId:
      AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId as HostOAuthDescriptor["descriptorId"],
    dialect: "directory-oidc",
    flow,
    clientId: String(configuration.directory.clientId),
    tenantId: String(configuration.directory.tenantId),
    audience: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.audience,
    endpointOrigin,
    scopes: [],
    termsId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.termsId as HostOAuthDescriptor["termsId"],
  };
}

/**
 * Organization sign-in for an OpenAI-compatible or Anthropic-compatible
 * gateway the organization runs itself, with its own OpenID Connect issuer.
 * The issuer, client, and scope are the instance's own; the issuer is fixed
 * when the instance is created. A gateway lives on the organization's own
 * host, so there is no host list: the grant binds to the origin it was
 * signed in for, and only that origin receives its bearer.
 */
export const GATEWAY_DIRECTORY_SIGN_IN = {
  descriptorId: "gateway-directory",
  termsId: "gateway-directory-1",
  /** Shown until the issuer names the account. */
  accountLabel: "Organization account",
  termsSummary:
    "Octant signs you in at your organization's own sign-in page and keeps the sign-in in this computer's credential broker. Requests to this gateway run as you, under your organization's policies. Sign out removes this computer's sign-in only; it does not end your organization session.",
} as const;

/** The https origin a gateway grant binds to, or undefined for any other address. */
export function gatewayDirectoryOrigin(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  return url.origin;
}

/**
 * The broker descriptor a gateway sign-in begins with, built from the
 * instance's configuration alone; undefined when the address is not https.
 */
export function gatewayDirectoryDescriptor(configuration: {
  readonly baseUrl: string;
  readonly directory: DirectoryIssuerBinding;
}): HostOAuthDescriptor | undefined {
  const endpointOrigin = gatewayDirectoryOrigin(configuration.baseUrl);
  if (endpointOrigin === undefined) return undefined;
  return {
    descriptorId: GATEWAY_DIRECTORY_SIGN_IN.descriptorId as HostOAuthDescriptor["descriptorId"],
    dialect: "issuer-oidc",
    flow: "authorization-code-pkce",
    clientId: String(configuration.directory.clientId),
    issuer: configuration.directory.issuer,
    endpointOrigin,
    scopes: [String(configuration.directory.scope)],
    termsId: GATEWAY_DIRECTORY_SIGN_IN.termsId as HostOAuthDescriptor["termsId"],
  };
}
