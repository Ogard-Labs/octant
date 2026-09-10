import { describe, expect, it, vi } from "vitest";
import {
  decodeComputerUseOwner,
  type ComputerControlCommand,
  type ComputerUseOwner,
  type ComputerUseSettings,
  type ComputerUseStatus,
} from "@octant/contracts/computer-use-plugin";
import { computerUseBrokerHandler } from "./computerUseBroker";

const token = "a".repeat(43);
const owner = decodeComputerUseOwner({
  windowId: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  mode: "code",
  providerInstanceId: "33333333-3333-4333-8333-333333333333",
  modelId: "fixture",
  executionPolicy: "approval-gated",
});
function fixture() {
  const status = async (): Promise<ComputerUseStatus> => ({
    supported: true,
    enabled: true,
    automaticUpdates: true,
    permissions: { accessibility: true, screenRecording: true },
    driver: "stopped",
    activeSessions: 0,
    update: "idle",
  });
  const service = {
    status: vi.fn(status),
    configure: vi.fn(async (_settings: ComputerUseSettings) => {}),
    reserve: vi.fn(async (_owner: ComputerUseOwner) => true),
    release: vi.fn(async (_owner: ComputerUseOwner) => {}),
    execute: vi.fn(
      async (
        _owner: ComputerUseOwner,
        _command: ComputerControlCommand,
        _signal?: AbortSignal,
      ) => ({ kind: "stopped" as const }),
    ),
    requestPermissions: status,
    openPermissionSettings: async () => {},
    checkUpdates: status,
    close: async () => {},
  };
  return { service, handle: computerUseBrokerHandler(service, token) };
}
function request(body: unknown, headers: HeadersInit = {}, signal?: AbortSignal) {
  return new Request("http://127.0.0.1/v1/computer-use", {
    method: "POST",
    headers: { "x-octant-computer-use-token": token, ...headers },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("Private computer-use broker", () => {
  it("refuses browser, remote, unauthenticated and malformed calls before host effects", async () => {
    const { service, handle } = fixture();
    expect(
      (await handle(request({ operation: "status" }, { origin: "http://127.0.0.1" }))).status,
    ).toBe(401);
    expect((await handle(request({ operation: "status" }), "192.0.2.1")).status).toBe(401);
    expect(
      (await handle(request({ operation: "status" }, { "x-octant-computer-use-token": "wrong" })))
        .status,
    ).toBe(401);
    expect(
      (
        await handle(
          request({
            operation: "execute",
            owner,
            command: { operation: "shell", command: "ignored" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(service.status).not.toHaveBeenCalled();
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("preserves the owner and cancellation signal for an authenticated action", async () => {
    const { service, handle } = fixture();
    const abort = new AbortController();
    const sent = request(
      { operation: "execute", owner, command: { operation: "stop" } },
      {},
      abort.signal,
    );
    const response = await handle(sent);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "stopped" });
    expect(service.execute).toHaveBeenCalledWith(owner, { operation: "stop" }, sent.signal);
    abort.abort();
    expect(service.execute.mock.calls[0]?.[2]?.aborted).toBe(true);
  });
});
