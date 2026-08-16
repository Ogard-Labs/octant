import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  decodeEntityId,
  decodeGlobalEntityReference,
  decodeHostHealth,
  decodeHostId,
  decodeHostIdentity,
  EntityId,
  GlobalEntityReference,
  HostHealth,
  HostId,
  HostIdentity,
  LOCAL_HOST_DISPLAY_NAME,
  LOCAL_HOST_ID,
} from "./host";

describe("HostId", () => {
  it("decodes a non-empty trimmed string", () => {
    expect(decodeHostId("local")).toBe("local");
    expect(decodeHostId("remote-server-1")).toBe("remote-server-1");
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(() => decodeHostId("")).toThrow();
    expect(() => decodeHostId("   ")).toThrow();
  });

  it("rejects non-string values", () => {
    expect(() => decodeHostId(42)).toThrow();
    expect(() => decodeHostId(null)).toThrow();
    expect(() => decodeHostId(undefined)).toThrow();
  });
});

describe("LOCAL_HOST_ID", () => {
  it("is the string 'local'", () => {
    expect(LOCAL_HOST_ID).toBe("local");
  });

  it("passes HostId validation", () => {
    expect(Schema.is(HostId)(LOCAL_HOST_ID)).toBe(true);
  });
});

describe("LOCAL_HOST_DISPLAY_NAME", () => {
  it("is 'This Mac'", () => {
    expect(LOCAL_HOST_DISPLAY_NAME).toBe("This Mac");
  });
});

describe("HostHealth", () => {
  it("accepts all valid health states", () => {
    const states = [
      "healthy",
      "connecting",
      "stale",
      "incompatible",
      "unauthorized",
      "unavailable",
    ] as const;
    for (const state of states) {
      expect(decodeHostHealth(state)).toBe(state);
    }
  });

  it("rejects unknown health states", () => {
    expect(() => decodeHostHealth("unknown")).toThrow();
    expect(() => decodeHostHealth("")).toThrow();
  });
});

describe("HostIdentity", () => {
  it("decodes a valid identity report", () => {
    const identity = decodeHostIdentity({
      hostId: "local",
      displayName: "This Mac",
      health: "healthy",
      capabilities: ["chat", "work", "code"],
    });
    expect(identity.hostId).toBe("local");
    expect(identity.displayName).toBe("This Mac");
    expect(identity.health).toBe("healthy");
    expect(identity.capabilities).toEqual(["chat", "work", "code"]);
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeHostIdentity({
        hostId: "local",
        displayName: "This Mac",
        health: "healthy",
        capabilities: [],
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => decodeHostIdentity({ hostId: "local" })).toThrow();
  });
});

describe("GlobalEntityReference", () => {
  it("decodes a valid { hostId, entityId } pair", () => {
    const ref = decodeGlobalEntityReference({
      hostId: "local",
      entityId: "thread-abc-123",
    });
    expect(ref.hostId).toBe("local");
    expect(ref.entityId).toBe("thread-abc-123");
  });

  it("rejects missing hostId", () => {
    expect(() => decodeGlobalEntityReference({ entityId: "abc" })).toThrow();
  });

  it("rejects missing entityId", () => {
    expect(() => decodeGlobalEntityReference({ hostId: "local" })).toThrow();
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeGlobalEntityReference({ hostId: "local", entityId: "abc", extra: 1 }),
    ).toThrow();
  });
});
