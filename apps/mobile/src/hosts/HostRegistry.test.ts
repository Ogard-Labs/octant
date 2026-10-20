import { describe, expect, it } from "vitest";
import { createInMemoryMobileHostRegistryStorage, createMobileHostRegistry } from "./HostRegistry";

describe("MobileHostRegistry", () => {
  it("stores a single host and keeps a multi-host-shaped list", async () => {
    const registry = createMobileHostRegistry(createInMemoryMobileHostRegistryStorage());
    const host = {
      hostId: "11111111-1111-4111-8111-111111111111",
      origin: "https://laptop.tailnet:8443",
      label: "Travel laptop",
      keyId: "key-1",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    };

    await registry.upsert(host);
    expect(await registry.list()).toEqual({ kind: "ok", hosts: [host] });
    expect(await registry.get(host.hostId)).toEqual(host);
  });

  it("upserts by hostId and removes independently", async () => {
    const registry = createMobileHostRegistry(createInMemoryMobileHostRegistryStorage());
    await registry.upsert({
      hostId: "11111111-1111-4111-8111-111111111111",
      origin: "https://a.example",
      label: "A",
      keyId: "k1",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    await registry.upsert({
      hostId: "22222222-2222-4222-8222-222222222222",
      origin: "https://b.example",
      label: "B",
      keyId: "k2",
      credentialGeneration: 1,
      hostKeyFingerprint: "b".repeat(64),
    });
    await registry.upsert({
      hostId: "11111111-1111-4111-8111-111111111111",
      origin: "https://a.example",
      label: "A renamed",
      keyId: "k1",
      credentialGeneration: 2,
      hostKeyFingerprint: "a".repeat(64),
    });

    const read = await registry.list();
    const listed = read.kind === "ok" ? read.hosts : [];
    expect(listed).toHaveLength(2);
    expect(listed[0]?.label).toBe("A renamed");
    expect(listed[0]?.credentialGeneration).toBe(2);

    await registry.remove("22222222-2222-4222-8222-222222222222");
    const afterRemove = await registry.list();
    expect(afterRemove.kind === "ok" ? afterRemove.hosts : []).toHaveLength(1);
  });

  it("reports corrupt storage as unreadable instead of throwing", async () => {
    for (const raw of ["{not json", '{"hostId":"a"}', '[{"hostId":"a"}]']) {
      const storage = createInMemoryMobileHostRegistryStorage();
      await storage.setItem("octant.mobile.host-registry.v1", raw);
      const registry = createMobileHostRegistry(storage);

      expect((await registry.list()).kind).toBe("unreadable");
      expect(await registry.get("a")).toBeUndefined();
    }
  });

  it("keeps both hosts when two pairings overlap", async () => {
    const registry = createMobileHostRegistry(createInMemoryMobileHostRegistryStorage());
    const registration = (hostId: string) => ({
      hostId,
      origin: `https://${hostId}.example`,
      label: hostId,
      keyId: "k",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });

    await Promise.all([registry.upsert(registration("a")), registry.upsert(registration("b"))]);

    const read = await registry.list();
    expect(read.kind === "ok" ? read.hosts.map((host) => host.hostId) : []).toEqual(["a", "b"]);
  });

  it("lets a person pair again over a corrupt list", async () => {
    const storage = createInMemoryMobileHostRegistryStorage();
    await storage.setItem("octant.mobile.host-registry.v1", "{not json");
    const registry = createMobileHostRegistry(storage);

    await registry.upsert({
      hostId: "a",
      origin: "https://a.example",
      label: "A",
      keyId: "k",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });

    expect((await registry.list()).kind).toBe("ok");
  });
});
