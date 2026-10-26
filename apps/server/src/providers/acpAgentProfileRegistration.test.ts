import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  decodeProviderInstance,
  decodeProviderRegistryCommand,
  ProviderDriverKind,
  type AcpAgentConfiguration,
} from "@octant/contracts";
import {
  canAutoDetectDriverKind,
  canLocateRuntimeBinary,
  createAcpAgentProvider,
  driverLabel,
  isNativeToolRuntimeDriver,
  providerCliUpdateArgs,
} from "@octant/domain";
import { providerToolTransport } from "@octant/domain/provider-runtime-integration";
import {
  admittedBundledProviderDriverKinds,
  bundledProviderDriverPlugin,
} from "@octant/plugin-host/provider-drivers";
import { DISCOVERY_DESCRIPTORS } from "@octant/provider-sdk/discovery";
import { providerDriverHostRuntime } from "@octant/provider-sdk/driver-plugins";
import { createProviderFromDiscoveryCandidate } from "./discoveryProviderCreate";
import { locatedBinaryCommand } from "./locatedBinaryCommand";
import { providerLimitsReporting } from "./providerLimitsReporting";

// A throwaway profile that exists only in this test. Every consumer below must
// pick it up from the profile table alone: none of them may name it.
vi.mock("@octant/contracts/acp-agent-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octant/contracts/acp-agent-profiles")>();
  const profiles = {
    ...actual.ACP_AGENT_PROFILES,
    "probe-agent": {
      name: "Probe Agent",
      executable: "probe-agent",
      versionProbeArgs: ["--version"],
      authentication: ["provider-owned", "api-key"],
      apiKeyLabel: "Probe API key",
      signInGuidance: "Run probe-agent login, then check the connection again.",
      cliUpdateArgs: ["self-update"],
      bundledPluginSerial: 0x19,
    },
  } satisfies Readonly<Record<string, import("@octant/contracts").AcpAgentProfileDescriptor>>;
  const kinds = Object.keys(profiles);
  const isKind = (kind: string): kind is keyof typeof profiles => kinds.includes(kind);
  // The module's own lookups close over the shipped table, so the ones every
  // consumer calls are rebuilt over the extended table here.
  return {
    ...actual,
    ACP_AGENT_PROFILES: profiles,
    ACP_AGENT_KINDS: kinds,
    isAcpAgentKind: isKind,
    acpAgentProfile: (kind: string) => {
      if (!isKind(kind)) throw new Error(`no profile for ${kind}`);
      return profiles[kind];
    },
    acpAgentKindOfConfiguration: (kind: string) => {
      const agent = kind.replace(/-acp$/, "");
      if (!isKind(agent)) throw new Error(`no profile for ${kind}`);
      return agent;
    },
  };
});

// The compiler knows only the shipped rows, so the probe's names are typed
// through `string`: this is the one place a test may hand them over.
const probeKind = String("probe-agent") as ProviderDriverKind;
const instanceId = "00000000-0000-4000-8000-0000000009a1";
const createdAt = "2026-10-26T10:00:00.000Z";
const configuration: AcpAgentConfiguration = {
  kind: String("probe-agent-acp") as AcpAgentConfiguration["kind"],
  binaryPath: "/opt/homebrew/bin/probe-agent",
  authentication: "provider-owned",
};

describe("a new ACP agent profile", () => {
  it("joins the closed driver vocabulary, instance schema, and commands from its row alone", () => {
    expect(Schema.decodeUnknownSync(ProviderDriverKind)("probe-agent")).toBe("probe-agent");
    const instance = decodeProviderInstance({
      id: instanceId,
      displayName: "Probe local",
      driverKind: "probe-agent",
      configuration,
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
    expect(instance.configuration).toEqual(configuration);
    expect(
      decodeProviderRegistryCommand({
        kind: "change-probe-agent-configuration",
        instanceId,
        expectedVersion: 1,
        configuration: { ...configuration, authentication: "api-key" },
      }),
    ).toMatchObject({ kind: "change-probe-agent-configuration" });
    // Its posture list still fails closed.
    expect(() =>
      decodeProviderRegistryCommand({
        kind: "create-probe-agent-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Probe local",
        configuration: { ...configuration, authentication: "subscription" },
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(ProviderDriverKind)("unlisted-agent")).toThrow();
  });

  it("takes its labels, capability placement, and policy from its row", () => {
    expect(driverLabel(probeKind)).toBe("Probe Agent ACP");
    expect(providerToolTransport(probeKind)).toBe("session-mcp-bridge");
    expect(canAutoDetectDriverKind(probeKind)).toBe(true);
    expect(isNativeToolRuntimeDriver(probeKind)).toBe(true);
    expect(canLocateRuntimeBinary(probeKind)).toBe(true);
    expect(providerCliUpdateArgs(probeKind)).toEqual(["self-update"]);
    expect(providerLimitsReporting(probeKind)).toBe("runtime-does-not-report");
    expect(
      createAcpAgentProvider({
        id: decodeProviderInstance({
          id: instanceId,
          displayName: "Probe local",
          driverKind: "probe-agent",
          configuration,
          enabled: true,
          environmentPolicy: "inherit-host",
          version: 1,
          createdAt,
          updatedAt: createdAt,
        }).id,
        displayName: "Probe local",
        configuration,
        existingInstances: [],
        expectedVersion: 0 as never,
        createdAt: createdAt as never,
      }),
    ).toMatchObject({ driverKind: "probe-agent", configuration });
  });

  it("ships as a bundled provider-driver plugin on the shared ACP host profile", () => {
    const plugin = bundledProviderDriverPlugin(probeKind);
    expect(plugin?.manifest).toMatchObject({
      slug: "probe-agent",
      displayName: "Probe Agent",
      extensionId: "10000000-0000-4000-8000-00000000021a",
    });
    expect(admittedBundledProviderDriverKinds().has(probeKind)).toBe(true);
    expect(providerDriverHostRuntime(probeKind)).toBe("acp-host-profile");
  });

  it("is discovered, registered, and pointed at a located binary through its row", () => {
    expect(
      DISCOVERY_DESCRIPTORS.find((descriptor) => descriptor.driverKind === probeKind),
    ).toMatchObject({
      displayName: "Probe Agent",
      executableNames: ["probe-agent"],
      versionProbeArgs: ["--version"],
      onboardingGuidance: "Run probe-agent login, then check the connection again.",
      isDirectEndpoint: false,
    });

    const { command } = createProviderFromDiscoveryCandidate(
      {
        driverKind: probeKind,
        displayName: "Probe Agent",
        binaryPath: "/opt/homebrew/bin/probe-agent",
      },
      { enabled: true },
    );
    expect(decodeProviderRegistryCommand(command)).toMatchObject({
      kind: "create-probe-agent-provider",
      configuration,
    });

    const instance = decodeProviderInstance({
      id: instanceId,
      displayName: "Probe local",
      driverKind: "probe-agent",
      configuration,
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 3,
      createdAt,
      updatedAt: createdAt,
    });
    expect(
      decodeProviderRegistryCommand(locatedBinaryCommand(instance, "/usr/local/bin/probe-agent")),
    ).toMatchObject({
      kind: "change-probe-agent-configuration",
      configuration: { ...configuration, binaryPath: "/usr/local/bin/probe-agent" },
    });
  });
});
