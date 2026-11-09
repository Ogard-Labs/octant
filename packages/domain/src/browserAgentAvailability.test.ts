import { decodeProviderModelId } from "@octant/contracts";
import { expect, it } from "vitest";
import { browserAgentAvailability, browserToolTransport } from "./browserAgentAvailability";

it("reports the same Browser admission facts without turning Plan into a grant", () => {
  const ready = { toolTransport: true, hostLendsBrowser: true, readOnly: false };
  expect(browserAgentAvailability(ready)).toEqual({ status: "available", readOnly: false });
  expect(browserAgentAvailability({ ...ready, readOnly: true })).toEqual({
    status: "available",
    readOnly: true,
  });
  expect(browserAgentAvailability({ ...ready, toolTransport: false })).toEqual({
    status: "omitted",
    reason: "no-tool-transport",
  });
  expect(browserAgentAvailability({ ...ready, toolConstraints: ["octant_terminal"] })).toEqual({
    status: "omitted",
    reason: "excluded-by-thread-constraints",
  });
  expect(browserAgentAvailability({ ...ready, hostLendsBrowser: false })).toEqual({
    status: "omitted",
    reason: "host-lends-no-browser",
  });
  expect(browserAgentAvailability({ ...ready, toolTransport: undefined })).toEqual({
    status: "unknown",
  });
});

it("does not lend verified endpoint transport to an unverified sibling model", () => {
  const observed = {
    capabilities: { appManagedTools: "unsupported" as const },
    verifiedToolModelIds: [decodeProviderModelId("verified-model")],
  };
  expect(browserToolTransport(observed, "verified-model")).toBe(true);
  expect(browserToolTransport(observed, "sibling-model")).toBe(false);
  expect(browserToolTransport(undefined, "verified-model")).toBeUndefined();
  expect(
    browserToolTransport(
      { ...observed, capabilities: { appManagedTools: "supported" } },
      "sibling-model",
    ),
  ).toBe(true);
});
