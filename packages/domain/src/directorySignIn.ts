import type { DirectoryBinding } from "@octant/contracts";
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
 */
export function azureFoundryDirectoryDescriptor(configuration: {
  readonly baseUrl: string;
  readonly directory: DirectoryBinding;
}): HostOAuthDescriptor | undefined {
  const endpointOrigin = azureFoundryDirectoryOrigin(configuration.baseUrl);
  if (endpointOrigin === undefined) return undefined;
  return {
    descriptorId:
      AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId as HostOAuthDescriptor["descriptorId"],
    dialect: "directory-oidc",
    flow: "authorization-code-pkce",
    clientId: String(configuration.directory.clientId),
    tenantId: String(configuration.directory.tenantId),
    audience: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.audience,
    endpointOrigin,
    scopes: [],
    termsId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.termsId as HostOAuthDescriptor["termsId"],
  };
}
