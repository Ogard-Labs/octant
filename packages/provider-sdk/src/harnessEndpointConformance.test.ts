import { decodeProviderModelId, decodeProviderSessionId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { ProviderHarnessEndpoint } from "./harnessEndpoint";
import { runHarnessEndpointConformance } from "./harnessEndpointConformance";

const modelId = decodeProviderModelId("endpoint-model");
const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-0000000000b1");

/** A direct endpoint written only against the port. */
function endpoint(
  options: { readonly admitsAnyTools?: boolean; readonly rawAbort?: boolean } = {},
): ProviderHarnessEndpoint {
  return {
    open: async () => {
      let active = true;
      return {
        fits: () => true,
        send: async (_request, stream) => {
          if (!active) throw { category: "protocol", message: "Provider session is not active." };
          if (stream.signal.aborted) {
            if (options.rawAbort === true) throw new Error("AbortError: the operation was aborted");
            throw { category: "interrupted", message: "The provider request was cancelled." };
          }
          stream.onEvent({ kind: "text-delta", text: "Hello." });
          return { text: "Hello.", toolCalls: [] };
        },
        release: () => {
          active = false;
        },
      };
    },
    admitTurn: (turn) =>
      options.admitsAnyTools === true || turn.tools.length === 0
        ? undefined
        : { category: "invalid-configuration", message: "Verify this model's tools first." },
  };
}

const fixture = (subject: ProviderHarnessEndpoint) => ({
  endpoint: subject,
  modelId,
  request: {
    sessionId,
    modelId,
    system: undefined,
    history: [{ role: "user" as const, text: "Say hello" }],
    tools: [],
  },
  unverifiedToolTurn: {
    sessionId,
    prompt: "Read the file",
    context: [],
    attachments: [],
    tools: [{ name: "read", inputSchema: { type: "object", properties: {} } }],
  },
});

describe("harness endpoint conformance", () => {
  it("passes an endpoint that refuses unverified tools, classifies a cancel, and stops after release", async () => {
    await expect(runHarnessEndpointConformance(fixture(endpoint()))).resolves.toEqual({
      unverifiedToolsRefusedBeforeAnyRequest: true,
      answeredWithASettledResponse: true,
      cancelledRequestInterrupted: true,
      releasedSessionRefused: true,
    });
  });

  it("fails an endpoint that admits tools for a model nobody verified", async () => {
    await expect(
      runHarnessEndpointConformance(fixture(endpoint({ admitsAnyTools: true }))),
    ).rejects.toThrow("a turn with unverified tools was admitted");
  });

  it("fails an endpoint whose cancel escapes as a raw error the host cannot classify", async () => {
    await expect(
      runHarnessEndpointConformance(fixture(endpoint({ rawAbort: true }))),
    ).rejects.toThrow("a send rejected with no provider failure");
  });
});
