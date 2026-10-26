import {
  decodeProviderInstanceId,
  type ProviderObservedState,
  type ProviderInstance,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { ProviderProbeFailure } from "../../providers/useProviderController";
import {
  endpointModelCount,
  endpointStatus,
  endpointSubLine,
  type EndpointStatusInput,
  type ModelEndpointInstance,
} from "./endpointStatus";

const id = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000e1");

function gateway(patch: Partial<ProviderInstance> = {}): ModelEndpointInstance {
  return {
    id,
    displayName: "Team gateway",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://gateway.example.internal/v1",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1 as never,
    createdAt: "2026-10-08T10:00:00.000Z" as never,
    updatedAt: "2026-10-08T10:00:00.000Z" as never,
    ...patch,
  } as ModelEndpointInstance;
}

function observed(patch: Partial<ProviderObservedState> = {}): ProviderObservedState {
  return {
    instanceId: id,
    readiness: "ready",
    processState: "running",
    models: [
      {
        id: "scribe-2" as never,
        displayName: "scribe-2",
        source: "discovered",
        verification: "verified",
        reasoning: "supported",
        inputModalities: ["text"],
        options: [],
      },
    ],
    capabilities: {} as ProviderObservedState["capabilities"],
    observedAt: "2026-10-08T10:00:00.000Z" as never,
    ...patch,
  };
}

function failure(
  category: ProviderProbeFailure["category"],
  message: string,
  reason?: ProviderProbeFailure["reason"],
): ProviderProbeFailure {
  return {
    category,
    message,
    ...(reason === undefined ? {} : { reason }),
    failedAt: "2026-10-08T10:00:00.000Z",
  };
}

const plan = { accountLabel: "ChatGPT plan", action: "Sign in with ChatGPT" };

function status(input: Partial<EndpointStatusInput>) {
  return endpointStatus({ instance: gateway(), observed: undefined, checking: false, ...input });
}

describe("endpoint row state", () => {
  it("does not claim signed out while the sign-in status is unresolved", () => {
    expect(status({ signInOffer: plan }).label).toBe("Checking sign-in…");
    expect(endpointSubLine(gateway(), undefined, plan)).toContain("checking sign-in…");
    expect(status({ signInOffer: plan, signIn: { kind: "linking" } }).label).toBe("Signing in…");
  });
  it.each<[string, Partial<EndpointStatusInput>, string, string | undefined, string | undefined]>([
    ["a ready endpoint", { observed: observed() }, "Ready", undefined, undefined],
    [
      "an endpoint that is off, whatever it last reported",
      { instance: gateway({ enabled: false }), failure: failure("protocol", "x") },
      "Off",
      undefined,
      undefined,
    ],
    [
      "a check in progress",
      { checking: true, observed: observed() },
      "Checking…",
      undefined,
      undefined,
    ],
    [
      "a sign-in endpoint never signed in",
      { signInOffer: plan, signIn: { kind: "signed-out", termsRequired: true } },
      "Sign in to use",
      undefined,
      "Sign in with ChatGPT",
    ],
    [
      "an expired sign-in",
      { signInOffer: plan, signIn: { kind: "expired" }, observed: observed() },
      "Signed out",
      "Your ChatGPT plan sign-in expired. Sign in again to keep using it.",
      "Sign in again",
    ],
    [
      "nothing answering at the address",
      { failure: failure("unavailable", "The provider endpoint could not be reached.") },
      "Can't connect",
      "Nothing answered at gateway.example.internal.",
      "Try again",
    ],
    [
      "a server error",
      { failure: failure("unavailable", "The provider request failed with HTTP 503.") },
      "Can't connect",
      "The server is busy or down (HTTP 503). Try again in a moment.",
      "Try again",
    ],
    [
      "a refused key",
      { failure: failure("unauthenticated", "The provider rejected the configured credential.") },
      "Key refused",
      "The service turned down the API key.",
      "Replace key",
    ],
    [
      "a missing key",
      {
        failure: failure("unauthenticated", "The provider credential is missing or unavailable."),
      },
      "Needs key",
      "No API key is saved for it.",
      "Add key",
    ],
    [
      "an address that answers with something other than models",
      { failure: failure("protocol", "The provider returned an invalid models response.") },
      "Not working",
      "The address replied, but not with a list of models. Check the address; it usually ends in /v1.",
      "Edit address",
    ],
    [
      "an endpoint that lists no models",
      { observed: observed({ readiness: "degraded", models: [] }) },
      "No models yet",
      "Connected, but it lists no models. Add the model IDs you use.",
      "Add model IDs",
    ],
    [
      "a failure the host stored only generically, after a reload",
      {
        observed: observed({
          readiness: "degraded",
          models: [],
          message: "Provider probe failed.",
        }),
      },
      "Not working",
      "The last check failed. Check again to see why.",
      "Try again",
    ],
    ["an endpoint never checked", {}, "Not checked yet", undefined, "Check now"],
  ])("says %s in words with at most one fix", (_case, input, label, sentence, fix) => {
    const result = status(input);
    expect(result.label).toBe(label);
    expect(result.sentence).toBe(sentence);
    expect(result.fix?.label).toBe(fix);
  });

  it("sends a browser to the desktop app for a missing key, with no fix it cannot do", () => {
    const result = status({
      keysHere: false,
      failure: failure("unauthenticated", "The provider credential is missing or unavailable."),
    });
    expect(result.label).toBe("Needs key");
    expect(result.tone).toBe("needs-you");
    expect(result.sentence).toBe("Add its API key in the Octant desktop app on this Mac.");
    expect(result.fix).toBeUndefined();
  });

  it("keeps saying Needs key in a browser after a reload, when only the observation is left", () => {
    const result = status({
      keysHere: false,
      observed: observed({ readiness: "unauthenticated", models: [] }),
    });
    expect(result.label).toBe("Needs key");
    expect(result.fix).toBeUndefined();
  });

  it("asks whether Ollama is running when nothing answers at its address", () => {
    const ollama = {
      ...gateway(),
      driverKind: "ollama",
      configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
    } as ModelEndpointInstance;
    expect(
      endpointStatus({
        instance: ollama,
        observed: undefined,
        checking: false,
        failure: failure("unavailable", "The provider endpoint could not be reached."),
      }).sentence,
    ).toBe("Nothing answered at 127.0.0.1:11434. Is Ollama running?");
  });

  it("prefers the precise failure over the generic observation the host kept", () => {
    expect(
      status({
        observed: observed({
          readiness: "degraded",
          models: [],
          message: "Provider probe failed.",
        }),
        failure: failure("protocol", "The provider returned an invalid models response."),
      }).sentence,
    ).toMatch(/not with a list of models/);
  });

  it("names who is signed in, or the host and whether a key is sent", () => {
    expect(endpointSubLine(gateway(), undefined, undefined)).toBe(
      "gateway.example.internal · API key",
    );
    const keyless = gateway({
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "http://127.0.0.1:8080/v1",
        authentication: "none",
        protocol: "auto",
        manualModelIds: [],
      },
    } as Partial<ProviderInstance>);
    expect(endpointSubLine(keyless, undefined, undefined)).toBe("127.0.0.1:8080 · No key");
    expect(
      endpointSubLine(gateway(), { kind: "signed-in", accountLabel: "someone@example.com" }, plan),
    ).toBe("Signed in as someone@example.com");
  });

  it("counts shown models once some are hidden", () => {
    const many = observed({
      models: [observed().models[0]!, { ...observed().models[0]!, id: "other" as never }],
    });
    expect(endpointModelCount(gateway(), many, [])).toBe("2 models");
    expect(
      endpointModelCount(gateway(), many, [{ providerInstanceId: id, modelId: "other" as never }]),
    ).toBe("1 of 2 shown");
  });
});

describe("an Azure AI Foundry endpoint that signs in with the organization", () => {
  const foundry = gateway({
    driverKind: "azure-foundry",
    configuration: {
      kind: "azure-foundry-openai-http",
      baseUrl: "https://contoso.openai.azure.com/openai/v1/",
      authentication: "directory-oauth",
      protocol: "auto",
      manualModelIds: ["gpt-main" as never],
      directory: {
        tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f" as never,
        clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d" as never,
      },
    },
  } as Partial<ProviderInstance>);
  const directoryBinding = {
    tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f" as never,
    clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d" as never,
    endpointOrigin: "https://contoso.openai.azure.com",
  };
  const refused = (patch: Partial<ProviderObservedState>) =>
    endpointStatus({
      instance: foundry,
      observed: observed({ models: [], directoryBinding, ...patch }),
      checking: false,
    });

  it("tells a sign-in the organization wants repeated in person from one that ended", () => {
    expect(
      refused({ readiness: "unauthenticated", unauthenticatedReason: "interaction-required" }),
    ).toEqual({
      tone: "needs-you",
      label: "Sign in again",
      sentence:
        "Your organization asks you to sign in again in person, for example to complete multi-factor authentication.",
      fix: { kind: "sign-in-again", label: "Sign in again" },
    });
    expect(
      refused({ readiness: "unauthenticated", unauthenticatedReason: "expired" }),
    ).toMatchObject({ label: "Signed out", fix: { kind: "sign-in-again" } });
    expect(
      refused({ readiness: "unauthenticated", unauthenticatedReason: "missing" }),
    ).toMatchObject({
      label: "Sign in to use",
      fix: { kind: "sign-in", label: "Sign in with your organization" },
    });
  });

  it("names the missing role, and a sign-in for another tenant, without offering a key", () => {
    const noRole = refused({
      readiness: "unauthenticated",
      unauthenticatedReason: "not-authorized",
    });
    expect(noRole).toMatchObject({ tone: "failed", label: "No access" });
    expect(noRole.sentence).toContain("Cognitive Services OpenAI User");
    expect(noRole.fix).toBeUndefined();
    expect(refused({ readiness: "incompatible" })).toMatchObject({
      label: "Sign-in doesn't match",
      fix: { kind: "sign-in-again" },
    });
    expect(endpointSubLine(foundry, undefined, undefined)).toBe(
      "contoso.openai.azure.com · Organization sign-in",
    );
  });
});
