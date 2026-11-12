import { Schema } from "effect";
import {
  DuplicateEventRegistration,
  EventPayloadInvalid,
  UnknownEventName,
  UnsupportedEventVersion,
} from "./journalErrors";

type RegisteredSchema = Schema.Schema<unknown, unknown, never>;

interface RegisteredSchemas {
  readonly current: RegisteredSchema;
  readonly persisted: RegisteredSchema;
}

export interface EventRegistration {
  readonly eventName: string;
  readonly eventVersion: number;
}

export class EventRegistry {
  readonly #schemas = new Map<string, RegisteredSchemas>();
  readonly #versionsByName = new Map<string, Set<number>>();

  register<A, I, R, PersistedA = A, PersistedI = I, PersistedR = R>(
    eventName: string,
    eventVersion: number,
    schema: Schema.Schema<A, I, R>,
    options?: {
      readonly persistedSchema: Schema.Schema<PersistedA, PersistedI, PersistedR>;
    },
  ): EventRegistry {
    const key = this.#key(eventName, eventVersion);
    if (this.#schemas.has(key)) {
      throw new DuplicateEventRegistration({ eventName, eventVersion });
    }

    this.#schemas.set(key, {
      current: schema as RegisteredSchema,
      persisted: (options?.persistedSchema ?? schema) as RegisteredSchema,
    });
    const versions = this.#versionsByName.get(eventName) ?? new Set<number>();
    versions.add(eventVersion);
    this.#versionsByName.set(eventName, versions);
    return this;
  }

  decode(eventName: string, eventVersion: number, payload: unknown): unknown {
    return this.#decode(eventName, eventVersion, payload, "current");
  }

  decodePersisted(eventName: string, eventVersion: number, payload: unknown): unknown {
    return this.#decode(eventName, eventVersion, payload, "persisted");
  }

  registrations(): ReadonlyArray<EventRegistration> {
    return [...this.#versionsByName.entries()]
      .flatMap(([eventName, versions]) =>
        [...versions].map((eventVersion) => ({ eventName, eventVersion })),
      )
      .sort(
        (left, right) =>
          left.eventName.localeCompare(right.eventName) || left.eventVersion - right.eventVersion,
      );
  }

  #decode(
    eventName: string,
    eventVersion: number,
    payload: unknown,
    mode: keyof RegisteredSchemas,
  ): unknown {
    const versions = this.#versionsByName.get(eventName);
    if (versions === undefined) {
      throw new UnknownEventName({ eventName });
    }

    const schemas = this.#schemas.get(this.#key(eventName, eventVersion));
    if (schemas === undefined) {
      throw new UnsupportedEventVersion({ eventName, eventVersion });
    }

    try {
      return Schema.decodeUnknownSync(schemas[mode])(payload);
    } catch {
      throw new EventPayloadInvalid({ eventName, eventVersion });
    }
  }

  #key(eventName: string, eventVersion: number): string {
    return `${eventName}@${eventVersion}`;
  }
}
