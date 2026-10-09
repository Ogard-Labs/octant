import {
  MAX_NATIVE_HARNESS_SLOT_CANDIDATES,
  NATIVE_HARNESS_BUILT_IN_SLOTS,
  nativeHarnessSlotCandidateKey,
  type NativeHarnessRoutingConfiguration,
  type NativeHarnessSlot,
  type NativeHarnessSlotCandidate,
  type NativeHarnessSlotId,
  type ProviderModel,
} from "@octant/contracts";

/** The kinds of endpoint Add endpoint connects by address, in the order it offers them. */
export type EndpointKind =
  | "azure-foundry"
  | "openai-compatible"
  | "anthropic-compatible"
  | "ollama";

export interface EndpointKindPresentation {
  readonly kind: EndpointKind;
  readonly title: string;
  readonly detail: string;
  /** Whether the endpoint takes a key: Azure always does, Ollama never does. */
  readonly key: "required" | "optional" | "none";
  readonly urlLabel: string;
  readonly urlPlaceholder: string;
  readonly urlHint: string;
  readonly defaultName?: string;
  readonly defaultUrl?: string;
}

export const ENDPOINT_KINDS: ReadonlyArray<EndpointKindPresentation> = [
  {
    kind: "azure-foundry",
    title: "Azure AI Foundry",
    detail: "Your Azure deployments, by name.",
    key: "required",
    urlLabel: "Foundry address",
    urlPlaceholder: "https://<resource>.openai.azure.com/openai/v1/",
    urlHint: "Ends in /openai/v1/. The key is sent as the api-key header.",
  },
  {
    kind: "openai-compatible",
    title: "OpenAI-compatible",
    detail: "Any service that speaks the OpenAI API: a gateway, a router, or a local server.",
    key: "optional",
    urlLabel: "Address",
    urlPlaceholder: "https://gateway.example/v1",
    urlHint: "Usually ends in /v1. Remote addresses need HTTPS.",
  },
  {
    kind: "anthropic-compatible",
    title: "Anthropic-compatible",
    detail: "A service that speaks the Anthropic Messages API.",
    key: "optional",
    urlLabel: "Address",
    urlPlaceholder: "https://api.anthropic.com/v1",
    urlHint: "Usually ends in /v1. Remote addresses need HTTPS.",
  },
  {
    kind: "ollama",
    title: "Local (Ollama)",
    detail: "Models already installed in Ollama on this computer. No key.",
    key: "none",
    urlLabel: "Ollama address",
    urlPlaceholder: "http://127.0.0.1:11434",
    urlHint: "Octant connects to Ollama you already run; it doesn't install or start it.",
    defaultName: "Ollama",
    defaultUrl: "http://127.0.0.1:11434",
  },
];

export function endpointKindPresentation(kind: EndpointKind): EndpointKindPresentation {
  const found = ENDPOINT_KINDS.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`Unknown endpoint kind ${kind}`);
  return found;
}

/**
 * Azure AI Foundry hosts its OpenAI v1 API under these domains. An address on
 * one of them entered as a plain OpenAI-compatible endpoint would miss the
 * api-key header and the deployment list, so Add endpoint suggests switching.
 */
const AZURE_HOST =
  /\.(?:openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/i;

export function looksLikeAzureFoundry(url: string): boolean {
  try {
    return AZURE_HOST.test(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

/** The Foundry OpenAI v1 base an Azure address belongs to: its origin plus /openai/v1/. */
export function azureFoundryBaseUrl(url: string): string {
  try {
    return `${new URL(url.trim()).origin}/openai/v1/`;
  } catch {
    return url;
  }
}

/** A catalogue longer than this is searched rather than listed whole. */
export const MODEL_LIST_LIMIT = 8;

/**
 * The models a search shows, at most `limit` of them, so a catalogue of
 * hundreds never floods the dialog. Chosen models stay listed first so a pick
 * does not vanish when the search changes.
 */
export function modelsToList(
  models: ReadonlyArray<ProviderModel>,
  query: string,
  chosen: ReadonlySet<string>,
  limit: number = MODEL_LIST_LIMIT,
): { readonly listed: ReadonlyArray<ProviderModel>; readonly more: number } {
  const search = query.trim().toLowerCase();
  const matching = models.filter((model) =>
    `${model.displayName} ${String(model.id)}`.toLowerCase().includes(search),
  );
  const ordered = [
    ...matching.filter((model) => chosen.has(String(model.id))),
    ...matching.filter((model) => !chosen.has(String(model.id))),
  ];
  return { listed: ordered.slice(0, limit), more: Math.max(0, ordered.length - limit) };
}

/** What one model's tool check found while Add endpoint was open. */
export type ToolCheck =
  | { readonly kind: "waiting" }
  | { readonly kind: "running" }
  | { readonly kind: "verified" }
  | { readonly kind: "chat-only"; readonly reason: string; readonly retry: boolean };

/**
 * Only a model Octant has seen call its tools may take a harness role or be
 * offered to helper agents: a role or helper runs Octant's tools, so a Chat
 * only model fails closed, even for a job that would send no tools.
 */
export function mayTakeAgentWork(check: ToolCheck | undefined): boolean {
  return check?.kind === "verified";
}

/**
 * The Octant Harness roles Add endpoint can give a verified model, by the
 * names Model roles uses. Reading images is offered only to a model that
 * reads them.
 */
export const ASSIGNABLE_ROLES: ReadonlyArray<{
  readonly id: NativeHarnessSlotId;
  readonly label: string;
  readonly needsImages?: true;
}> = [
  { id: NATIVE_HARNESS_BUILT_IN_SLOTS.default, label: "Main model" },
  { id: NATIVE_HARNESS_BUILT_IN_SLOTS.plan, label: "Planning" },
  { id: NATIVE_HARNESS_BUILT_IN_SLOTS.slow, label: "Careful review" },
  { id: NATIVE_HARNESS_BUILT_IN_SLOTS.task, label: "Research and lookups" },
  { id: NATIVE_HARNESS_BUILT_IN_SLOTS.smol, label: "Quick jobs" },
  { id: NATIVE_HARNESS_BUILT_IN_SLOTS.vision, label: "Reading images", needsImages: true },
  { id: NATIVE_HARNESS_BUILT_IN_SLOTS.advisor, label: "Advisor" },
];

/**
 * Makes `candidate` a role's first choice. The models the role already had
 * stay on as its backups, so assigning from Add endpoint never drops a choice
 * the person made before; the list keeps the routing table's ceiling.
 */
export function withFirstChoice(
  configuration: NativeHarnessRoutingConfiguration,
  slotId: NativeHarnessSlotId,
  candidate: NativeHarnessSlotCandidate,
): NativeHarnessRoutingConfiguration {
  const key = nativeHarnessSlotCandidateKey(candidate);
  const existing = configuration.slots.find((slot) => String(slot.id) === String(slotId));
  const others = (existing?.candidates ?? []).filter(
    (entry) => nativeHarnessSlotCandidateKey(entry) !== key,
  );
  const candidates = [candidate, ...others].slice(0, MAX_NATIVE_HARNESS_SLOT_CANDIDATES);
  // The overflow promotion may not repeat a model in the chain, so one that
  // just became the first choice stops being the promotion.
  const promotion = existing?.overflowPromotion;
  const slot: NativeHarnessSlot =
    promotion === undefined || nativeHarnessSlotCandidateKey(promotion) === key
      ? { id: slotId, candidates }
      : { id: slotId, candidates, overflowPromotion: promotion };
  return {
    ...configuration,
    slots: [...configuration.slots.filter((entry) => String(entry.id) !== String(slotId)), slot],
  };
}
