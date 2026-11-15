import type {
  WebSearchBackendEntry,
  WebSearchBackendId,
  WebSearchBackendKind,
  WebSearchIneligibleReason,
  WebSearchSettings,
  WebSearchSettingsRefusalCode,
} from "@octant/contracts/web-search";
import { actsAsHostPerson, type PrincipalKind } from "./remoteAccessPolicy";

/**
 * What a search vendor offers, as its published terms say. A person's ZDR or
 * EU statement about an entry is accepted only where its vendor offers it:
 * Octant cannot read the person's contract, so it can only refuse a statement
 * no agreement with that vendor could make true.
 *
 * Each kind carries the date its terms were checked and the source they were
 * read from; an entry changes only when that source does.
 */
export interface WebSearchBackendOffer {
  readonly kind: WebSearchBackendKind;
  /** The product name a person reads in Settings. */
  readonly label: string;
  readonly index: string;
  /** Whether an entry of this kind names an address: an instance, or a vendor's regional host. */
  readonly address: "required" | "optional" | "never";
  readonly zdr: { readonly offered: boolean; readonly terms: string };
  readonly euProcessing: { readonly offered: boolean; readonly terms: string };
  readonly checkedOn: string;
  readonly source: string;
}

export const WEB_SEARCH_BACKEND_OFFERS: Readonly<
  Record<WebSearchBackendKind, WebSearchBackendOffer>
> = {
  searxng: {
    kind: "searxng",
    label: "SearXNG",
    index: "Metasearch over the engines it enables",
    address: "required",
    // A self-hosted instance keeps and sends what its operator configures,
    // so either statement can be true of one; the engines it enables are a
    // separate question Settings warns about.
    zdr: { offered: true, terms: "Self-hosted: as configured" },
    euProcessing: { offered: true, terms: "Self-hosted: as configured" },
    checkedOn: "2026-11-14",
    source: "https://docs.searxng.org/admin/settings/settings_search.html",
  },
};

export type WebSearchBackendEligibility =
  | { readonly kind: "eligible" }
  | { readonly kind: "not-eligible"; readonly reason: WebSearchIneligibleReason };

/** A statement counts only where the person made it and the vendor offers it. */
function statesZdr(entry: WebSearchBackendEntry): boolean {
  return entry.statesZdr && WEB_SEARCH_BACKEND_OFFERS[entry.kind].zdr.offered;
}

function statesEuProcessing(entry: WebSearchBackendEntry): boolean {
  return entry.statesEuProcessing && WEB_SEARCH_BACKEND_OFFERS[entry.kind].euProcessing.offered;
}

export function webSearchBackendEligibility(
  entry: WebSearchBackendEntry,
  policy: WebSearchSettings["policy"],
): WebSearchBackendEligibility {
  if (!entry.enabled) return { kind: "not-eligible", reason: "disabled" };
  const needsZdr = policy === "zdr-only" || policy === "eu-and-zdr";
  const needsEu = policy === "eu-only" || policy === "eu-and-zdr";
  if (needsZdr && !statesZdr(entry)) return { kind: "not-eligible", reason: "zdr-not-stated" };
  if (needsEu && !statesEuProcessing(entry)) {
    return { kind: "not-eligible", reason: "eu-processing-not-stated" };
  }
  return { kind: "eligible" };
}

/**
 * The entries that may receive a query, in the person's order. Empty means
 * `web-search` is not offered at all: no request leaves the host without a
 * backend the person set up and the policy allows.
 */
export function eligibleWebSearchBackends(
  settings: WebSearchSettings,
): ReadonlyArray<WebSearchBackendEntry> {
  return settings.backends.filter(
    (entry) => webSearchBackendEligibility(entry, settings.policy).kind === "eligible",
  );
}

export type WebSearchSettingsDecision =
  | { readonly kind: "allow"; readonly settings: WebSearchSettings }
  | {
      readonly kind: "refused";
      readonly code: WebSearchSettingsRefusalCode;
      readonly message: string;
    };

function refused(code: WebSearchSettingsRefusalCode, message: string): WebSearchSettingsDecision {
  return { kind: "refused", code, message };
}

/**
 * Whether a settings change may be saved. Only the host's own person, at a
 * window of the host or on a device they paired, changes where a query may
 * go: the rule a provider's native setup already follows. An agent has no
 * path here, and a device another person introduced is refused.
 *
 * The address's own form (HTTPS, or HTTP on loopback) is the server's check;
 * this decides what the list may hold.
 */
export function decideWebSearchSettings(input: {
  readonly principalKind: PrincipalKind;
  readonly settings: WebSearchSettings;
}): WebSearchSettingsDecision {
  if (!actsAsHostPerson(input.principalKind)) {
    return refused("unauthorized", "Only this host's own person can change web search.");
  }
  const seen = new Set<string>();
  for (const entry of input.settings.backends) {
    if (seen.has(String(entry.id))) {
      return refused("duplicate-entry", "Each web search backend can appear once.");
    }
    seen.add(String(entry.id));
    const offer = WEB_SEARCH_BACKEND_OFFERS[entry.kind];
    if (offer.address === "required" && entry.address === undefined) {
      return refused("address-required", `${offer.label} needs the address of its instance.`);
    }
    if (offer.address === "never" && entry.address !== undefined) {
      return refused("address-not-taken", `${offer.label} has one address; it takes no other.`);
    }
    if (entry.statesZdr && !offer.zdr.offered) {
      return refused(
        "statement-not-offered",
        `${offer.label} has not published terms under which it keeps no record of queries (${offer.zdr.terms}).`,
      );
    }
    if (entry.statesEuProcessing && !offer.euProcessing.offered) {
      return refused(
        "statement-not-offered",
        `${offer.label} does not offer processing only in the EU or UK (${offer.euProcessing.terms}).`,
      );
    }
  }
  return { kind: "allow", settings: input.settings };
}

/**
 * The list a host reads before its person ever saved one: the SearXNG address
 * Chat settings held becomes one entry, with no statements made, under Any, so
 * a host that searched before searches the same way after. No address, no
 * entries.
 */
export function webSearchSettingsFromChatAddress(
  searxngBaseUrl: string | undefined,
  entryId: WebSearchBackendId,
): WebSearchSettings {
  const address = searxngBaseUrl?.trim();
  return {
    policy: "any",
    backends:
      address === undefined || address.length === 0
        ? []
        : [
            {
              id: entryId,
              kind: "searxng",
              address,
              enabled: true,
              statesZdr: false,
              statesEuProcessing: false,
            },
          ],
  };
}
