import type { ProviderToolDefinition } from "@octant/contracts";

export interface AppManagedToolSet {
  readonly definitions: ReadonlyArray<ProviderToolDefinition>;
  readonly execute: (input: {
    readonly name: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly result: unknown; readonly isError?: boolean }>;
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
  return {
    definitions: present.flatMap((set) => set.definitions),
    execute: async (input) => {
      const owner = present.find((set) =>
        set.definitions.some((definition) => definition.name === input.name),
      );
      if (owner === undefined) return { result: { error: "tool-unavailable" }, isError: true };
      return owner.execute(input);
    },
  };
}
