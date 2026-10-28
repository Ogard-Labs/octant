import { describe, expect, it, vi } from "vitest";
import type { NativeHarnessSessionView, ProviderInstanceId } from "@octant/contracts";
import { queueSteeringWhereDelivered, withSteerable } from "./nativeHarnessSteerability";

const harnessLead = "00000000-0000-4000-8000-000000000001" as ProviderInstanceId;
const runtimeLead = "00000000-0000-4000-8000-000000000002" as ProviderInstanceId;
const delivers = (id: ProviderInstanceId) => String(id) === String(harnessLead);

function viewOf(providerInstanceId: ProviderInstanceId): NativeHarnessSessionView {
  return { session: { lead: { providerInstanceId } } } as never;
}

describe("steering notes", () => {
  it("marks a native-harness session steerable and a runtime-provider session not", () => {
    expect(withSteerable(viewOf(harnessLead), delivers).steerable).toBe(true);
    expect(withSteerable(viewOf(runtimeLead), delivers).steerable).toBe(false);
  });

  it("refuses to queue a note for a runtime-provider lead and queues it for a native harness", () => {
    const queueSteering = vi.fn(() => "queued" as const);
    const note = { id: "n1", text: "Prefer the smaller change" } as never;
    const sessionsFor = (lead: ProviderInstanceId) => ({
      read: () => viewOf(lead),
      queueSteering,
    });
    expect(
      queueSteeringWhereDelivered(sessionsFor(runtimeLead) as never, delivers, "t", note),
    ).toBe("no-session");
    expect(queueSteering).not.toHaveBeenCalled();
    expect(
      queueSteeringWhereDelivered(sessionsFor(harnessLead) as never, delivers, "t", note),
    ).toBe("queued");
    expect(queueSteering).toHaveBeenCalledOnce();
  });
});
