import { decodeProviderInstanceId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { NativeSessionRuntimePool } from "./nativeSessionRuntimePool";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000001");

describe("NativeSessionRuntimePool", () => {
  it("does not retain a rejected idle close for later shutdowns", async () => {
    const pool = new NativeSessionRuntimePool();
    const close = vi.fn(async () => {
      throw new Error("runtime close failed");
    });

    await pool.retain(instanceId, "session", {
      value: 1,
      compatibility: "same",
      close,
    });

    await expect(pool.close()).rejects.toThrow("runtime close failed");
    await expect(pool.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
