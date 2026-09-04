import { describe, expect, it } from "vitest";
import { DISCOVERY_DESCRIPTORS } from "./discovery";
import {
  discoverableDescriptorsForAdmittedDrivers,
  discoveryDescriptorsForAdmittedDrivers,
  isAcpHostProfileDriver,
  providerDriverHostRuntime,
} from "./driverPlugins";

describe("provider-driver host runtime", () => {
  it("classifies every discovery descriptor without inventing a second ACP runtime", () => {
    const runtimes = new Map(
      DISCOVERY_DESCRIPTORS.map((descriptor) => [
        descriptor.driverKind,
        providerDriverHostRuntime(descriptor.driverKind),
      ]),
    );
    expect(runtimes.get("kilo")).toBe("acp-host-profile");
    expect(runtimes.get("devin")).toBe("acp-host-profile");
    expect(runtimes.get("mistral-vibe")).toBe("acp-host-profile");
    expect(runtimes.get("kimi-code")).toBe("acp-host-profile");
    expect(runtimes.get("grok")).toBe("acp-host-profile");
    expect(runtimes.get("goose")).toBe("acp-host-profile");
    expect(runtimes.get("glm")).toBe("acp-host-profile");
    expect(runtimes.get("gemini")).toBe("acp-host-profile");
    expect(runtimes.get("copilot")).toBe("acp-host-profile");
    expect(runtimes.get("cline")).toBe("acp-host-profile");
    expect(runtimes.get("qwen")).toBe("acp-host-profile");
    expect(runtimes.get("codex")).toBe("managed-process");
    expect(runtimes.get("claude")).toBe("managed-process");
    expect(runtimes.get("opencode")).toBe("managed-process");
    expect(runtimes.get("pi")).toBe("managed-process");
    expect(runtimes.get("oh-my-pi")).toBe("managed-process");
    expect(runtimes.get("ollama")).toBe("managed-process");
    expect(runtimes.get("openai-compatible")).toBe("direct-endpoint");
    expect(runtimes.get("anthropic-compatible")).toBe("direct-endpoint");
    expect(runtimes.get("azure-foundry")).toBe("direct-endpoint");
    expect(
      DISCOVERY_DESCRIPTORS.filter((descriptor) =>
        isAcpHostProfileDriver(descriptor.driverKind),
      ).map((descriptor) => descriptor.driverKind),
    ).toEqual(["kimi-code", "devin", "kilo", "mistral-vibe", "grok", "goose", "glm", "gemini", "copilot", "cline", "qwen"]);
  });

  it("omits models from discovery when a driver plugin is not admitted", () => {
    const admitted = new Set(["codex", "openai-compatible"] as const);
    expect(
      discoveryDescriptorsForAdmittedDrivers(admitted).map((descriptor) => descriptor.driverKind),
    ).toEqual(["codex", "openai-compatible"]);
    expect(
      discoverableDescriptorsForAdmittedDrivers(admitted).map(
        (descriptor) => descriptor.driverKind,
      ),
    ).toEqual(["codex"]);
  });

  it("contributes no discoverable runtimes when no driver plugin is admitted", () => {
    expect(discoverableDescriptorsForAdmittedDrivers(new Set()).map((d) => d.driverKind)).toEqual(
      [],
    );
  });
});
