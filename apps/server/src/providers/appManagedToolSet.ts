import type { ProviderToolDefinition, ProviderToolImage } from "@octant/contracts";

export interface AppManagedToolSet {
  readonly definitions: ReadonlyArray<ProviderToolDefinition>;
  readonly close?: () => Promise<void>;
  readonly execute: (input: {
    readonly name: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly result: unknown;
    readonly isError?: boolean;
    readonly images?: ReadonlyArray<ProviderToolImage>;
  }>;
}

/**
 * Compose independent app-managed tool sets into one provider-facing set.
 * Each call routes to the set that advertised the tool; nothing else may
 * answer for it.
 */
export function combineAppManagedToolSets(
  ...sets: ReadonlyArray<AppManagedToolSet | undefined>
): AppManagedToolSet {
  const present = sets.filter((set): set is AppManagedToolSet => set !== undefined);
  let closing: Promise<void> | undefined;
  return {
    definitions: present.flatMap((set) => set.definitions),
    close: () => {
      closing ??= Promise.all(present.map((set) => set.close?.())).then(() => undefined);
      return closing;
    },
    execute: async (input) => {
      const owner = present.find((set) =>
        set.definitions.some((definition) => definition.name === input.name),
      );
      if (owner === undefined) return { result: { error: "tool-unavailable" }, isError: true };
      return owner.execute(input);
    },
  };
}

/**
 * Answer `operation: "help"` for an offered tool family from its own usage
 * text. The always-visible tool prefix stays small and capability detail loads
 * lazily on use; that detail is allowed through a
 * read-only operation on a tool that is already offered. Help is static text,
 * so it never reaches the family's executor and every other action passes the
 * same authority path it did before. A family the set does not offer gets no
 * help: its call falls through and is refused as before.
 */
export function withToolFamilyHelp(
  set: AppManagedToolSet,
  help: Readonly<Record<string, string>>,
): AppManagedToolSet {
  return {
    ...set,
    execute: async (input) => {
      const usage = help[input.name];
      if (
        usage !== undefined &&
        set.definitions.some((definition) => definition.name === input.name) &&
        requestsHelp(input.inputJson)
      ) {
        return { result: { tool: input.name, help: usage }, isError: false };
      }
      return set.execute(input);
    },
  };
}

function requestsHelp(inputJson: string): boolean {
  try {
    const input: unknown = JSON.parse(inputJson);
    return (
      typeof input === "object" &&
      input !== null &&
      "operation" in input &&
      input.operation === "help"
    );
  } catch {
    return false;
  }
}
