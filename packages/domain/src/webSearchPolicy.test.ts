import type { WebSearchBackendEntry, WebSearchSettings } from "@octant/contracts/web-search";
import { describe, expect, it } from "vitest";
import {
  WEB_SEARCH_BACKEND_OFFERS,
  decideWebSearchSettings,
  eligibleWebSearchBackends,
  webSearchBackendEligibility,
  webSearchSettingsFromChatAddress,
} from "./webSearchPolicy";

const MIGRATED_ID = "00000000-0000-4000-8000-0000000000a1" as WebSearchBackendEntry["id"];

function entry(
  id: string,
  overrides: Partial<Omit<WebSearchBackendEntry, "id">> = {},
): WebSearchBackendEntry {
  return {
    id: `00000000-0000-4000-8000-00000000000${id}` as WebSearchBackendEntry["id"],
    kind: "searxng",
    address: `https://search-${id}.example/`,
    enabled: true,
    statesZdr: false,
    statesEuProcessing: false,
    ...overrides,
  };
}

const none = entry("1");
const zdr = entry("2", { statesZdr: true });
const eu = entry("3", { statesEuProcessing: true });
const both = entry("4", { statesZdr: true, statesEuProcessing: true });
const list = [none, zdr, eu, both];

function eligibleIds(policy: WebSearchSettings["policy"]): ReadonlyArray<string> {
  return eligibleWebSearchBackends({ policy, backends: list }).map((found) => String(found.id));
}

describe("which web search backends may receive a query", () => {
  it("lets every enabled backend receive a query under Any, in the person's order", () => {
    expect(eligibleIds("any")).toEqual([none.id, zdr.id, eu.id, both.id]);
  });

  it("lets only backends the person stated keep no record receive a query under ZDR only", () => {
    expect(eligibleIds("zdr-only")).toEqual([zdr.id, both.id]);
  });

  it("lets only backends the person stated process in the EU or UK receive a query under EU only", () => {
    expect(eligibleIds("eu-only")).toEqual([eu.id, both.id]);
  });

  it("needs both statements under EU and ZDR", () => {
    expect(eligibleIds("eu-and-zdr")).toEqual([both.id]);
  });

  it("never lets a turned-off backend receive a query, whatever it states", () => {
    const off = entry("5", { enabled: false, statesZdr: true, statesEuProcessing: true });
    expect(webSearchBackendEligibility(off, "any")).toEqual({
      kind: "not-eligible",
      reason: "disabled",
    });
    expect(eligibleWebSearchBackends({ policy: "any", backends: [off] })).toEqual([]);
  });

  it("names the statement a backend is missing under the policy", () => {
    expect(webSearchBackendEligibility(eu, "eu-and-zdr")).toEqual({
      kind: "not-eligible",
      reason: "zdr-not-stated",
    });
    expect(webSearchBackendEligibility(zdr, "eu-and-zdr")).toEqual({
      kind: "not-eligible",
      reason: "eu-processing-not-stated",
    });
  });
});

describe("saving web search settings", () => {
  const settings: WebSearchSettings = { policy: "zdr-only", backends: [zdr] };

  it("lets a window of the host and a device its own person paired change the settings", () => {
    expect(decideWebSearchSettings({ principalKind: "local-window", settings })).toEqual({
      kind: "allow",
      settings,
    });
    expect(decideWebSearchSettings({ principalKind: "person-paired-device", settings }).kind).toBe(
      "allow",
    );
  });

  it("refuses a device another person introduced", () => {
    expect(decideWebSearchSettings({ principalKind: "remote-device", settings })).toMatchObject({
      kind: "refused",
      code: "unauthorized",
    });
  });

  it("refuses the same backend twice", () => {
    expect(
      decideWebSearchSettings({
        principalKind: "local-window",
        settings: { policy: "any", backends: [zdr, zdr] },
      }),
    ).toMatchObject({ kind: "refused", code: "duplicate-entry" });
  });

  it("refuses a SearXNG entry without the address of its instance", () => {
    const { address: _address, ...withoutAddress } = none;
    expect(
      decideWebSearchSettings({
        principalKind: "local-window",
        settings: { policy: "any", backends: [withoutAddress] },
      }),
    ).toMatchObject({
      kind: "refused",
      code: "address-required",
      message: "SearXNG needs the address of its instance.",
    });
  });

  it("carries the date and source each vendor's terms were read from", () => {
    for (const offer of Object.values(WEB_SEARCH_BACKEND_OFFERS)) {
      expect(offer.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(offer.source).toMatch(/^https:\/\//);
    }
  });
});

describe("the list a host reads before its person saved one", () => {
  it("turns Chat's SearXNG address into one entry under Any with no statements made", () => {
    expect(webSearchSettingsFromChatAddress("https://search.example/", MIGRATED_ID)).toEqual({
      policy: "any",
      backends: [
        {
          id: MIGRATED_ID,
          kind: "searxng",
          address: "https://search.example/",
          enabled: true,
          statesZdr: false,
          statesEuProcessing: false,
        },
      ],
    });
  });

  it("holds no entries for a host with no SearXNG address", () => {
    expect(webSearchSettingsFromChatAddress(undefined, MIGRATED_ID)).toEqual({
      policy: "any",
      backends: [],
    });
    expect(webSearchSettingsFromChatAddress("  ", MIGRATED_ID).backends).toEqual([]);
  });
});

describe("statements a vendor's terms cannot support", () => {
  function vendor(
    kind: WebSearchBackendEntry["kind"],
    overrides: Partial<Omit<WebSearchBackendEntry, "id" | "kind">> = {},
  ): WebSearchBackendEntry {
    return {
      id: "00000000-0000-4000-8000-0000000000c1" as WebSearchBackendEntry["id"],
      kind,
      enabled: true,
      statesZdr: false,
      statesEuProcessing: false,
      ...overrides,
    };
  }
  const save = (backend: WebSearchBackendEntry) =>
    decideWebSearchSettings({
      principalKind: "local-window",
      settings: { policy: "any", backends: [backend] },
    });

  it("refuses Staan's ZDR statement until it publishes retention terms, and accepts its EU statement", () => {
    expect(save(vendor("staan", { statesZdr: true }))).toEqual({
      kind: "refused",
      code: "statement-not-offered",
      message:
        "Staan has not published terms under which it keeps no record of queries (Not published).",
    });
    expect(save(vendor("staan", { statesEuProcessing: true })).kind).toBe("allow");
  });

  it("refuses an EU processing statement for Brave Search and Exa, whose terms offer none", () => {
    for (const kind of ["brave", "exa"] as const) {
      expect(save(vendor(kind, { statesEuProcessing: true }))).toMatchObject({
        kind: "refused",
        code: "statement-not-offered",
      });
      expect(save(vendor(kind, { statesZdr: true })).kind).toBe("allow");
    }
  });

  it("accepts both statements where the vendor offers them by agreement", () => {
    for (const kind of ["mojeek", "linkup"] as const) {
      expect(save(vendor(kind, { statesZdr: true, statesEuProcessing: true })).kind).toBe("allow");
    }
  });

  it("refuses an address for a vendor with one host, and lets Linkup name its agreed host", () => {
    expect(save(vendor("brave", { address: "https://brave.example/" }))).toMatchObject({
      kind: "refused",
      code: "address-not-taken",
    });
    expect(save(vendor("linkup", { address: "https://eu.linkup.example/" })).kind).toBe("allow");
    expect(save(vendor("linkup")).kind).toBe("allow");
  });

  it("counts a stored statement the vendor does not offer as not made", () => {
    const stored = vendor("brave", { statesZdr: true, statesEuProcessing: true });
    expect(webSearchBackendEligibility(stored, "eu-only")).toEqual({
      kind: "not-eligible",
      reason: "eu-processing-not-stated",
    });
  });
});
