import {
  AmazonBedrockProviderConfiguration,
  DirectoryIssuer,
  DirectoryIssuerClientId,
  DirectoryResourceScope,
  type AnthropicCompatibleProtocol,
  type AnthropicCompatibleProviderConfiguration,
  type AzureFoundryProviderConfiguration,
  type BflImageProviderConfiguration,
  type DirectoryClientId,
  type DirectoryIssuerBinding,
  type DirectoryTenantId,
  type GeminiImageAspectRatio,
  type GeminiImageProviderConfiguration,
  type GeminiImageResolution,
  type IdeogramImageProviderConfiguration,
  type OpenAiCompatibleProtocol,
  type OpenAiCompatibleProviderConfiguration,
  type OpenAiImageProviderConfiguration,
  type OpenAiImageQuality,
  type OpenAiImageSize,
} from "@octant/contracts";
import { Schema } from "effect";

/**
 * An OpenAI-compatible configuration from its form. A gateway that signs in
 * with its organization carries the issuer, client, and scope the form holds.
 */
export function configurationFrom(data: FormData): OpenAiCompatibleProviderConfiguration {
  const shared = {
    kind: "openai-compatible-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    protocol: String(data.get("protocol") ?? "auto") as OpenAiCompatibleProtocol,
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  } as const;
  if (data.get("authentication") === "directory-oauth") {
    return { ...shared, authentication: "directory-oauth", directory: gatewayDirectoryFrom(data) };
  }
  return {
    ...shared,
    authentication: data.get("authentication") === "none" ? "none" : "bearer",
  };
}

/** As `configurationFrom`, for an Anthropic-compatible endpoint. */
export function anthropicConfigurationFrom(
  data: FormData,
): AnthropicCompatibleProviderConfiguration {
  const authentication = data.get("authentication");
  const shared = {
    kind: "anthropic-compatible-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    protocol: String(data.get("protocol") ?? "auto") as AnthropicCompatibleProtocol,
    protocolVersion: String(data.get("protocolVersion") ?? "2023-06-01"),
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  } as const;
  if (authentication === "directory-oauth") {
    return { ...shared, authentication: "directory-oauth", directory: gatewayDirectoryFrom(data) };
  }
  return {
    ...shared,
    authentication:
      authentication === "bearer" || authentication === "none" ? authentication : "api-key",
  };
}

/**
 * A gateway's organization sign-in as the form holds it, trimmed. The host
 * compares the issuer exactly with what its tokens name, so it is not
 * otherwise rewritten; the host refuses a value that is not one.
 */
export function gatewayDirectoryFrom(data: FormData): DirectoryIssuerBinding {
  const text = (name: string) => String(data.get(name) ?? "").trim();
  return {
    issuer: text("issuer") as DirectoryIssuerBinding["issuer"],
    clientId: text("clientId") as DirectoryIssuerBinding["clientId"],
    scope: text("scope") as DirectoryIssuerBinding["scope"],
  };
}

/** Whether a gateway's issuer, client, and scope are each one the host accepts. */
export function isGatewayDirectory(directory: DirectoryIssuerBinding): boolean {
  return (
    Schema.is(DirectoryIssuer)(directory.issuer) &&
    Schema.is(DirectoryIssuerClientId)(directory.clientId) &&
    Schema.is(DirectoryResourceScope)(directory.scope)
  );
}

/**
 * An Azure AI Foundry configuration from its form. The form names how it signs
 * in; one without the field (an older form) keeps the API key. An organization
 * sign-in carries the tenant and client the person pasted, lowercased, since
 * the host compares them exactly and refuses anything but a GUID.
 */
export function foundryConfigurationFrom(data: FormData): AzureFoundryProviderConfiguration {
  const shared = {
    kind: "azure-foundry-openai-http",
    baseUrl: String(data.get("baseUrl") ?? ""),
    protocol: String(data.get("protocol") ?? "auto") as OpenAiCompatibleProtocol,
    manualModelIds: parseManualModelIds(String(data.get("manualModelIds") ?? "")),
  } as const;
  if (data.get("authentication") !== "directory-oauth") {
    return { ...shared, authentication: "api-key" };
  }
  return {
    ...shared,
    authentication: "directory-oauth",
    directory: {
      tenantId: directoryGuid(data.get("tenantId")) as DirectoryTenantId,
      clientId: directoryGuid(data.get("clientId")) as DirectoryClientId,
    },
    // Off is the absence of the opt-in; the host stores no `false`.
    ...(data.get("deviceCodeSignIn") === null ? {} : { deviceCodeSignIn: true }),
  };
}

/**
 * An Amazon Bedrock configuration from its form, or undefined when a field is
 * not one the host takes: a commercial-partition region for the models and
 * for the portal, the access portal address exactly as the organization
 * publishes it, a twelve-digit account, a permission-set name, and 1 to 64
 * models. Pasted values are tidied the way they are usually copied (an
 * account shown as 1234-5678-9012, a portal address with the page's
 * trailing `/#/`), and nothing else is rewritten.
 */
export function bedrockConfigurationFrom(
  data: FormData,
): AmazonBedrockProviderConfiguration | undefined {
  const text = (name: string) => String(data.get(name) ?? "").trim();
  const candidate = {
    kind: "amazon-bedrock-converse-http",
    region: text("region").toLowerCase(),
    authentication: "cloud-iam",
    cloudIam: {
      startUrl: portalAddress(text("startUrl")),
      ssoRegion: text("ssoRegion").toLowerCase(),
      accountId: text("accountId").replaceAll("-", "").replaceAll(" ", ""),
      roleName: text("roleName"),
    },
    manualModelIds: parseManualModelIds(text("manualModelIds")),
  };
  return Schema.is(AmazonBedrockProviderConfiguration)(candidate) ? candidate : undefined;
}

/** A portal address without the trailing `/`, `#`, or `#/` a browser's address bar adds. */
function portalAddress(value: string): string {
  let address = value;
  for (const suffix of ["#/", "#", "/"]) {
    if (address.endsWith(suffix)) address = address.slice(0, -suffix.length);
  }
  return address;
}

/** A pasted directory id as the host compares it: trimmed and lowercase. */
export function directoryGuid(value: FormDataEntryValue | string | null): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const DIRECTORY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a pasted tenant or client id is a GUID once lowercased. */
export function isDirectoryGuid(value: string): boolean {
  return DIRECTORY_GUID.test(directoryGuid(value));
}

export function parseManualModelIds(
  value: string,
): OpenAiCompatibleProviderConfiguration["manualModelIds"] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ] as unknown as OpenAiCompatibleProviderConfiguration["manualModelIds"];
}

export function optionalSelectValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function openAiImageConfigurationFrom(data: FormData): OpenAiImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  const quality = optionalSelectValue(String(data.get("quality") ?? "")) as
    | OpenAiImageQuality
    | undefined;
  const size = optionalSelectValue(String(data.get("size") ?? "")) as OpenAiImageSize | undefined;
  return {
    kind: "openai-image-http",
    modelAllowlist: modelAllowlist as unknown as OpenAiImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as OpenAiImageProviderConfiguration["defaultModel"],
    ...(quality === undefined ? {} : { quality }),
    ...(size === undefined ? {} : { size }),
  };
}

export function geminiImageConfigurationFrom(data: FormData): GeminiImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  const aspectRatio = optionalSelectValue(String(data.get("aspectRatio") ?? "")) as
    | GeminiImageAspectRatio
    | undefined;
  const resolution = optionalSelectValue(String(data.get("resolution") ?? "")) as
    | GeminiImageResolution
    | undefined;
  return {
    kind: "gemini-native-image-http",
    modelAllowlist: modelAllowlist as unknown as GeminiImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as GeminiImageProviderConfiguration["defaultModel"],
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...(resolution === undefined ? {} : { resolution }),
  };
}

export function bflImageConfigurationFrom(data: FormData): BflImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  return {
    kind: "bfl-image-http",
    modelAllowlist: modelAllowlist as unknown as BflImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as BflImageProviderConfiguration["defaultModel"],
    ...optionalBaseUrl(data),
  };
}

export function ideogramImageConfigurationFrom(data: FormData): IdeogramImageProviderConfiguration {
  const modelAllowlist = parseManualModelIds(String(data.get("modelAllowlist") ?? ""));
  const enteredDefault = String(data.get("defaultModel") ?? "").trim();
  const defaultModel = enteredDefault.length > 0 ? enteredDefault : (modelAllowlist[0] ?? "");
  return {
    kind: "ideogram-image-http",
    modelAllowlist:
      modelAllowlist as unknown as IdeogramImageProviderConfiguration["modelAllowlist"],
    defaultModel: defaultModel as IdeogramImageProviderConfiguration["defaultModel"],
    ...optionalBaseUrl(data),
  };
}

/** Blank leaves the profile on its provider's own endpoint. */
function optionalBaseUrl(data: FormData): { readonly baseUrl?: string } {
  const baseUrl = String(data.get("baseUrl") ?? "").trim();
  return baseUrl.length === 0 ? {} : { baseUrl };
}
