import type {
  ProviderToolDefinition,
  ProviderTurnInput,
  ProviderToolImage,
  ShieldWatcherLabel,
  ThreadRoutineReceipt,
} from "@octant/contracts";

export interface AppManagedToolSet {
  readonly definitions: ReadonlyArray<ProviderToolDefinition>;
  /**
   * The native harness's own search grant for this turn: the provider's
   * built-in web search the research route, the thread's taint, and its level
   * allow. It is decided when the turn is sent, not when its tools are
   * composed: preparing the turn's context (a mention of a marked thread) or
   * settling an owed outside-content mark can taint the thread in between,
   * and a grant read earlier would offer built-in search beside that content.
   * Carried through every set that combines or wraps this one; absent offers
   * none.
   */
  readonly providerWebSearch?: (
    sessionId: ProviderTurnInput["sessionId"],
  ) => ProviderTurnInput["providerWebSearch"];
  readonly close?: () => Promise<void>;
  readonly execute: (input: {
    readonly name: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal;
    /**
     * The provider's id for this call, when the caller has one. It pairs the
     * call's journaled intent with its settlement and reaches no tool's input.
     */
    readonly toolCallId?: string;
    /**
     * Receives the person-facing approval wait the call's record measured
     * while it executed, when one ran inside the recorded-call boundary. A
     * caller that times the whole execution subtracts it; sets that do not
     * record calls simply never invoke it.
     */
    readonly onApprovalWait?: (waitMs: number) => void;
  }) => Promise<{
    readonly result: unknown;
    readonly isError?: boolean;
    readonly images?: ReadonlyArray<ProviderToolImage>;
    /**
     * Set when the result brought outside content into the thread, with what
     * Octant Shield's Watcher found in it; the tool row carries the mark.
     */
    readonly outsideContent?: { readonly labels: ReadonlyArray<ShieldWatcherLabel> };
    /** Set when the call created a routine; the tool row carries what was created. */
    readonly routine?: ThreadRoutineReceipt;
  }>;
}

/**
 * The provider-search grant a turn is sent with, decided at that moment: every
 * turn runner reads it here, in the expression that builds its send, after
 * the turn's context and any owed outside-content mark are settled.
 */
export function providerWebSearchAtSend(
  set: AppManagedToolSet | undefined,
  sessionId: ProviderTurnInput["sessionId"],
): Pick<ProviderTurnInput, "providerWebSearch"> {
  const providerWebSearch = set?.providerWebSearch?.(sessionId);
  return providerWebSearch === undefined ? {} : { providerWebSearch };
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
  const providerWebSearch = present.find(
    (set) => set.providerWebSearch !== undefined,
  )?.providerWebSearch;
  return {
    definitions: present.flatMap((set) => set.definitions),
    ...(providerWebSearch === undefined ? {} : { providerWebSearch }),
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
