import { decodeProviderModelId } from "@octant/contracts";
import { expect, it } from "vitest";
import {
  browserAgentAvailability,
  browserToolTransport,
  threadAppToolSupport,
} from "./browserAgentAvailability";

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

it("offers a mixed runtime Octant's tools only at Full access and labels them mixed", () => {
  const unproved = {
    appManagedTools: "unsupported" as const,
    appManagedToolsAtFullAccess: "mixed" as const,
  };
  expect(threadAppToolSupport(unproved, { executionPolicy: "full-access" })).toBe("mixed");
  expect(
    threadAppToolSupport(unproved, { executionPolicy: "full-access", fullAccessSandbox: true }),
  ).toBe("mixed");
  for (const executionPolicy of ["plan", "approval-gated", "auto-accept-edits"] as const) {
    expect(threadAppToolSupport(unproved, { executionPolicy })).toBe("unsupported");
    expect(browserToolTransport({ capabilities: unproved }, "model", { executionPolicy })).toBe(
      false,
    );
  }
  expect(
    browserToolTransport({ capabilities: unproved }, "model", { executionPolicy: "full-access" }),
  ).toBe(true);
  expect(browserToolTransport({ capabilities: unproved }, "model")).toBe(false);
});

it("labels a proved runtime mixed once Full access launches it outside the sandbox", () => {
  const proved = {
    appManagedTools: "supported" as const,
    appManagedToolsAtFullAccess: "mixed" as const,
  };
  expect(threadAppToolSupport(proved, { executionPolicy: "approval-gated" })).toBe("supported");
  expect(threadAppToolSupport(proved, { executionPolicy: "full-access" })).toBe("mixed");
  expect(
    threadAppToolSupport(proved, { executionPolicy: "full-access", fullAccessSandbox: true }),
  ).toBe("supported");
  expect(
    threadAppToolSupport({ appManagedTools: "unsupported" }, { executionPolicy: "full-access" }),
  ).toBe("unsupported");
});
