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
    expect(await registry.list()).toEqual([host]);
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

    const listed = await registry.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]?.label).toBe("A renamed");
    expect(listed[0]?.credentialGeneration).toBe(2);

    await registry.remove("22222222-2222-4222-8222-222222222222");
    expect(await registry.list()).toHaveLength(1);
  });
});
