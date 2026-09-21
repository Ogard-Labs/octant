import { describe, expect, it } from "vitest";
import { decodeWorkTurnRequestId } from "@octant/contracts/work-turns";
import { WorkTurnUsageStore } from "./workTurnUsageStore";

const requestId = decodeWorkTurnRequestId("77777777-0000-4000-8000-000000000001");

describe("WorkTurnUsageStore", () => {
  it("hands a waiting caller the tokens the provider reported for its turn", () => {
    const store = new WorkTurnUsageStore();

    store.record(requestId, { inputTokens: 120, outputTokens: 30 });

    expect(store.take(requestId)).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it("yields a turn's figures once, so a second reader cannot double-count them", () => {
    const store = new WorkTurnUsageStore();
    store.record(requestId, { inputTokens: 120, outputTokens: 30 });

    store.take(requestId);

    expect(store.take(requestId)).toBeUndefined();
  });

  it("drops the oldest entry at capacity instead of growing without bound", () => {
    const store = new WorkTurnUsageStore({ capacity: 2 });
    const first = decodeWorkTurnRequestId("77777777-0000-4000-8000-000000000001");
    const second = decodeWorkTurnRequestId("77777777-0000-4000-8000-000000000002");
    const third = decodeWorkTurnRequestId("77777777-0000-4000-8000-000000000003");

    store.record(first, { inputTokens: 1, outputTokens: 1 });
    store.record(second, { inputTokens: 2, outputTokens: 2 });
    store.record(third, { inputTokens: 3, outputTokens: 3 });

    expect(store.take(first)).toBeUndefined();
    expect(store.take(second)).toEqual({ inputTokens: 2, outputTokens: 2 });
    expect(store.take(third)).toEqual({ inputTokens: 3, outputTokens: 3 });
  });
});
