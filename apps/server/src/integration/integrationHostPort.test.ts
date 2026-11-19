import { describe, expect, it } from "vitest";
import type { IntegrationActivitySource } from "@octant/plugin-api/integration";
import { createIntegrationHostPort, integrationActivitySourceSlot } from "./integrationHostPort";

const source = (label: string): IntegrationActivitySource => ({
  account: async () => ({ status: "connected", account: label }),
  readRepository: async () => ({ status: "repository-missing" }),
});

describe("integrationActivitySourceSlot", () => {
  it("serves the registered source only while the integration is effective", () => {
    let effective = false;
    const slot = integrationActivitySourceSlot(() => effective);
    const port = createIntegrationHostPort({
      registerActivitySource: slot.registerActivitySource,
    });
    const activity = source("henrik");
    const registration = port.registerActivitySource?.(activity);
    expect(registration?.kind).toBe("registered");
    expect(slot.current()).toBeUndefined();
    effective = true;
    expect(slot.current()).toBe(activity);
    effective = false;
    expect(slot.current()).toBeUndefined();
  });

  it("refuses a second active binding and lets only the newest release revoke", () => {
    const slot = integrationActivitySourceSlot(() => true);
    const port = createIntegrationHostPort({
      registerActivitySource: slot.registerActivitySource,
    });
    const activity = source("one");
    const first = port.registerActivitySource?.(activity);
    expect(first?.kind).toBe("registered");
    const duplicate = port.registerActivitySource?.(source("two"));
    expect(duplicate).toEqual({ kind: "refused" });
    if (first?.kind !== "registered") throw new Error("first registration refused");
    first.release();
    first.release();
    expect(slot.current()).toBeUndefined();
    const second = port.registerActivitySource?.(activity);
    expect(second?.kind).toBe("registered");
    first.release();
    expect(slot.current()).toBe(activity);
  });
});
