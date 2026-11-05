import { describe, expect, it, vi } from "vitest";
import type { SecretStoreBrokerClient } from "./secretStoreBrokerClient";
import type { SecretStoresJournal } from "./secretStoresJournal";
import { makeConnectorLinkedSecrets } from "./connectorLinkedSecrets";

const secretId = "55000000-0000-4000-8000-000000000001";
describe("linked MCP pointer retirement", () => {
  it.each(["cleared", "none", "broker-unavailable"] as const)(
    "distinguishes definitive absence from unknown deletion (%s)",
    async (status) => {
      const clear = vi.fn<SecretStoreBrokerClient["clear"]>(async () =>
        status === "cleared"
          ? { status, store: "onepassword", reference: "op://Private/App/secret" }
          : { status },
      );
      const record = vi.fn<SecretStoresJournal["record"]>();
      const linked = makeConnectorLinkedSecrets({
        broker: { point: async () => ({ status: "pointed" }), clear },
        journal: { record },
      });
      expect(await linked.retire?.(secretId)).toBe(
        status === "broker-unavailable" ? "uncertain" : "cleared",
      );
      expect(clear).toHaveBeenCalledExactlyOnceWith({ namespace: "mcp-server", id: secretId });
      expect(record).toHaveBeenCalledTimes(status === "cleared" ? 1 : 0);
    },
  );
  it("keeps existing forget callers void-returning while journaling a completed deletion", async () => {
    const record = vi.fn<SecretStoresJournal["record"]>();
    const linked = makeConnectorLinkedSecrets({
      broker: {
        point: async () => ({ status: "pointed" }),
        clear: async () => ({
          status: "cleared",
          store: "onepassword",
          reference: "op://Private/App/secret",
        }),
      },
      journal: { record },
    });
    expect(await linked.forget(secretId)).toBeUndefined();
    expect(record).toHaveBeenCalledWith({
      name: "credential-reference.cleared",
      target: { kind: "connector-secret", secretId },
      store: "onepassword",
      reference: "op://Private/App/secret",
    });
  });
  it("reports a lost point response as uncertain without clearing over a possible late write", async () => {
    const clear = vi.fn<SecretStoreBrokerClient["clear"]>(async () => ({ status: "none" }));
    const linked = makeConnectorLinkedSecrets({
      broker: { point: async () => ({ status: "broker-unavailable" }), clear },
      journal: { record: () => undefined },
    });
    expect(
      await linked.point(secretId, { store: "onepassword", reference: "op://Private/App/secret" }),
    ).toMatchObject({ status: "uncertain" });
    expect(clear).not.toHaveBeenCalled();
  });
  it("retains uncertainty when a journal failure's compensating clear has no definite reply", async () => {
    const linked = makeConnectorLinkedSecrets({
      broker: {
        point: async () => ({ status: "pointed" }),
        clear: async () => ({ status: "broker-unavailable" }),
      },
      journal: {
        record: () => {
          throw new Error("controlled journal failure");
        },
      },
    });
    expect(
      await linked.point(secretId, { store: "onepassword", reference: "op://Private/App/secret" }),
    ).toMatchObject({ status: "uncertain" });
  });
  it("keeps a definitive pre-write refusal distinct from transport uncertainty", async () => {
    const clear = vi.fn<SecretStoreBrokerClient["clear"]>(async () => ({ status: "none" }));
    const linked = makeConnectorLinkedSecrets({
      broker: { point: async () => ({ status: "locked" }), clear },
      journal: { record: () => undefined },
    });
    expect(
      await linked.point(secretId, { store: "onepassword", reference: "op://Private/App/secret" }),
    ).toMatchObject({ status: "refused" });
    expect(clear).not.toHaveBeenCalled();
  });
});
