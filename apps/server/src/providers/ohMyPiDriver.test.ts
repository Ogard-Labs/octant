import { describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import { decodeProviderInstanceId } from "@octant/contracts";
import { makeOhMyPiDriver } from "./ohMyPiDriver";
import type { OhMyPiProcessPort } from "./ohMyPiProcess";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000480");

describe("Oh My Pi driver probe", () => {
  it("probes models/state without acquiring a turn session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        type: "response",
        command: "get_available_models",
        success: true,
        data: {
          models: [
            {
              id: "gpt-test",
              name: "GPT Test",
              provider: "openai",
              reasoning: true,
              contextWindow: 128000,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "probe", isStreaming: false },
      });
    const processPort: OhMyPiProcessPort = {
      startProbe: (input) => {
        startInput = input;
        return Effect.succeed({
          version: "17.2.1",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          pid: 123,
          rpc: {
            request,
            send: vi.fn(),
            respondToUi: vi.fn(),
            onEvent: vi.fn(() => () => undefined),
            close: vi.fn(async () => undefined),
            exited: Promise.resolve(),
          },
          exited: Promise.resolve(),
        });
      },
    };
    let startInput: Parameters<OhMyPiProcessPort["startProbe"]>[0] | undefined;
    const runtimeRegistry = {
      setObservedState: vi.fn(),
    } as unknown as ProviderRuntimeRegistry;
    const driver = makeOhMyPiDriver({
      instanceId,
      binaryPath: "/Users/example/.bun/bin/omp",
      managedHome: "/tmp/octant-omp",
      supportedVersion: "17.2.1",
      process: processPort,
      runtimeRegistry,
      clock: () => "2026-08-01T00:00:00.000Z",
    });

    const result = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
    expect(result).toMatchObject({
      instanceId,
      readiness: "ready",
      detectedVersion: "17.2.1",
      models: [expect.objectContaining({ id: "openai/gpt-test" })],
    });
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "get_available_models",
      "get_state",
    ]);
    expect(startInput?.onProcessStarted).toEqual(expect.any(Function));
    expect(runtimeRegistry.setObservedState).toHaveBeenCalledOnce();

    const acquire = await Effect.runPromiseExit(
      Effect.scoped(
        driver.acquire({
          instanceId,
          projectRoot: "/tmp/project",
          mode: "code",
        }),
      ),
    );
    expect(Exit.isFailure(acquire)).toBe(true);
  });
});
