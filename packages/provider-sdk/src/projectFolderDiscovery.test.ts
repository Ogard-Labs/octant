import { describe, expect, it } from "vitest";
import {
  collectProviderProjectFolderDiscoveryPorts,
  type ProviderProjectFolderDiscoveryPort,
} from "./projectFolderDiscovery";

function fakePort(providerId: string): ProviderProjectFolderDiscoveryPort {
  return {
    providerId,
    discoverFolders: async () => ({ status: "completed" }),
  };
}

describe("provider project folder discovery ports", () => {
  it("deduplicates valid built-in and plugin ports while dropping malformed provider IDs", () => {
    const first = fakePort("claude");
    const duplicate = fakePort("claude");
    const plugin = fakePort("acme-agent");
    const malformedPath = fakePort("../escape");
    const malformedCase = fakePort("Upper Case");

    const collected = collectProviderProjectFolderDiscoveryPorts([
      first,
      malformedPath,
      duplicate,
      plugin,
      malformedCase,
    ]);

    expect(collected).toEqual([first, plugin]);
  });
});
