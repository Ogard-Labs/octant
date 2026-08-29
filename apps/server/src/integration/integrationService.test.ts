import { describe, expect, it, vi } from "vitest";
import { LINEAR_ISSUE_GET_OPERATION } from "@octant/contracts/linear-issues";
import { createMemorySecretVault } from "./integrationCredentialVault";
import { createLinearIntegrationService } from "./integrationService";
import { LINEAR_OAUTH_UNCONFIGURED } from "../plugins/linear/linearConstants";

const redirectUri = "http://127.0.0.1:52693/oauth/linear/callback";
const signal = () => new AbortController().signal;

function createService(options: { readonly isEffective?: () => boolean } = {}) {
  const fetch = vi.fn(async () => new Response(null, { status: 500 }));
  const vault = createMemorySecretVault();
  const has = vi.spyOn(vault, "has");
  return {
    fetch,
    has,
    service: createLinearIntegrationService({
      vault,
      config: { redirectUri },
      fetch,
      startCallbackListener: false,
      ...(options.isEffective === undefined ? {} : { isEffective: options.isEffective }),
    }),
  };
}

describe("Linear integration service construction", () => {
  it("does not construct Linear GraphQL or OAuth when the integration is not effective", async () => {
    const { service, fetch, has } = createService({ isEffective: () => false });
    await expect(service.snapshot("linear", signal())).resolves.toEqual({
      state: "unavailable",
      capabilities: [],
      remediation: "That integration is not available on this host.",
    });
    await expect(
      service.executeOperation(
        "linear",
        { kind: "operation", operationId: LINEAR_ISSUE_GET_OPERATION, input: { id: "issue" } },
        signal(),
      ),
    ).resolves.toEqual({
      kind: "refused",
      reason: "That integration is not available on this host.",
    });
    await expect(service.execute("linear", { kind: "setup" }, signal())).resolves.toEqual({
      state: "unavailable",
      capabilities: [],
      remediation: "That integration is not available on this host.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(has).not.toHaveBeenCalled();
  });

  it("loads Linear through the integration loader when the integration is effective", async () => {
    const { service, fetch, has } = createService({ isEffective: () => true });
    await expect(service.snapshot("linear", signal())).resolves.toEqual({
      state: "unauthorized",
      capabilities: [],
      remediation: LINEAR_OAUTH_UNCONFIGURED,
    });
    expect(has).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
