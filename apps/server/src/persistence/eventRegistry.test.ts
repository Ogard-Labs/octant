import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DuplicateEventRegistration,
  EventPayloadInvalid,
  UnknownEventName,
  UnsupportedEventVersion,
} from "./journalErrors";
import { EventRegistry } from "./eventRegistry";

const fixturePayload = Schema.Struct({ value: Schema.String });
const currentFixturePayload = Schema.Struct({
  value: Schema.String,
  current: Schema.Boolean,
});
const persistedFixturePayload = Schema.transform(Schema.Unknown, currentFixturePayload, {
  strict: false,
  decode: (persisted) =>
    typeof persisted === "object" && persisted !== null && !("current" in persisted)
      ? { ...persisted, current: true }
      : persisted,
  encode: (_persisted, current) => current,
});

describe("EventRegistry", () => {
  it("decodes a registered event payload", () => {
    const registry = new EventRegistry().register("fixture.recorded", 1, fixturePayload);

    expect(registry.decode("fixture.recorded", 1, { value: "saved" })).toEqual({ value: "saved" });
    expect(registry.decodePersisted("fixture.recorded", 1, { value: "saved" })).toEqual({
      value: "saved",
    });
  });

  it("uses a distinct persisted schema only for replay decoding", () => {
    const registry = new EventRegistry().register("fixture.recorded", 1, currentFixturePayload, {
      persistedSchema: persistedFixturePayload,
    });

    expect(() => registry.decode("fixture.recorded", 1, { value: "legacy" })).toThrow(
      EventPayloadInvalid,
    );
    expect(registry.decodePersisted("fixture.recorded", 1, { value: "legacy" })).toEqual({
      value: "legacy",
      current: true,
    });
    expect(registry.decode("fixture.recorded", 1, { value: "current", current: false })).toEqual({
      value: "current",
      current: false,
    });
    expect(
      registry.decodePersisted("fixture.recorded", 1, { value: "current", current: false }),
    ).toEqual({ value: "current", current: false });
  });

  it("rejects unknown event names and unsupported versions distinctly", () => {
    const registry = new EventRegistry().register("fixture.recorded", 1, fixturePayload);

    expect(() => registry.decode("fixture.missing", 1, { value: "saved" })).toThrow(
      UnknownEventName,
    );
    expect(() => registry.decode("fixture.recorded", 2, { value: "saved" })).toThrow(
      UnsupportedEventVersion,
    );
  });

  it("rejects a payload that does not match its registered schema without exposing it", () => {
    const registry = new EventRegistry().register("fixture.recorded", 1, fixturePayload);

    try {
      registry.decode("fixture.recorded", 1, { value: 42, private: "do-not-expose" });
      throw new Error("expected payload decoding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EventPayloadInvalid);
      expect(String(error)).not.toContain("do-not-expose");
    }
  });

  it("rejects duplicate registrations", () => {
    const registry = new EventRegistry().register("fixture.recorded", 1, fixturePayload);

    expect(() => registry.register("fixture.recorded", 1, fixturePayload)).toThrow(
      DuplicateEventRegistration,
    );
  });
});
