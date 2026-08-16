import type { ComputerUseActionRequest } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createMacOsComputerUseAdapter,
  type ComputerUseProcessPort,
} from "./macOsComputerUseAdapter";

const request = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  actionId: "20000000-0000-4000-8000-000000000001",
  correlationId: "30000000-0000-4000-8000-000000000001",
  authority: {
    hostId: "40000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "50000000-0000-4000-8000-000000000001",
    rootId: "60000000-0000-4000-8000-000000000001",
    providerInstanceId: "70000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  },
  kind: "type-text",
  visibility: "visible",
  target: "AXIdentifier:issue-373-field",
  value: "super-secret-value",
} as ComputerUseActionRequest;

function processResult(stdout: string, exitCode = 0): ComputerUseProcessPort {
  return {
    run: vi.fn(async () => ({ exitCode, stdout, stderr: exitCode === 0 ? "" : "failed" })),
  };
}

describe("macOS computer-use adapter", () => {
  it("observes only bounded accessibility metadata and classifies secure fields", async () => {
    const process = processResult(
      JSON.stringify({
        targetApp: "Octant QA Fixture",
        windowTitle: "Computer Use",
        role: "AXSecureTextField",
      }),
    );
    const adapter = createMacOsComputerUseAdapter({ process, platform: "darwin" });
    const observation = await adapter.observe(request, new AbortController().signal);

    expect(observation).toMatchObject({
      targetApp: "Octant QA Fixture",
      windowTitle: "Computer Use",
      sensitiveFieldKind: "password",
    });
    expect(observation.reference).not.toContain("Computer Use");
    expect(observation.reference).not.toContain(request.value!);
    expect(vi.mocked(process.run).mock.calls[0]?.[0].arguments.join(" ")).not.toContain(
      request.value!,
    );
  });

  it("keeps typed text off argv and binds execution to the observed app and selector", async () => {
    const process = processResult(JSON.stringify({ ok: true }));
    const adapter = createMacOsComputerUseAdapter({ process, platform: "darwin" });
    const observation = {
      targetApp: "Octant QA Fixture",
      windowTitle: "Computer Use",
      reference: "native-observation-1",
    };
    const result = await adapter.execute(request, observation, new AbortController().signal);
    const input = vi.mocked(process.run).mock.calls[0]?.[0];

    expect(input?.arguments).toEqual(
      expect.arrayContaining(["type-text", "Octant QA Fixture", request.target!]),
    );
    expect(input?.arguments.join(" ")).not.toContain(request.value!);
    expect(input?.stdin).toBe(request.value);
    expect(result.reference).not.toContain(request.value!);
  });

  it("fails closed off macOS and classifies helper death without leaking stderr", async () => {
    const unsupported = createMacOsComputerUseAdapter({
      process: processResult(""),
      platform: "linux",
    });
    await expect(unsupported.observe(request, new AbortController().signal)).rejects.toMatchObject({
      category: "unavailable",
    });

    const died = createMacOsComputerUseAdapter({
      process: processResult("", 9),
      platform: "darwin",
    });
    await expect(died.observe(request, new AbortController().signal)).rejects.toMatchObject({
      category: "process-died",
      message: "Native computer-use helper ended before observation completed.",
    });
  });
});
