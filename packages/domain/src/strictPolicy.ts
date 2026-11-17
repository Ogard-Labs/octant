import type { ProviderExecutionPolicy } from "@octant/contracts";

export interface StrictPreferences {
  readonly strict?: boolean | undefined;
  readonly fullAccessSandbox?: boolean | undefined;
}
export interface StrictDefaults {
  readonly defaultStrict?: boolean | undefined;
  readonly defaultFullAccessSandbox?: boolean | undefined;
}
export interface StrictResolution {
  readonly enabled: boolean;
  readonly source: "thread" | "project" | "settings" | "default";
  readonly legacy: boolean;
}

/** Legacy choices retain their original level boundary until the person saves
 * the shared Strict preference. Explicit false is an inheritance override. */
export function resolveStrictPolicy(input: {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly thread?: StrictPreferences;
  readonly project?: StrictDefaults;
  readonly settings?: StrictDefaults;
  readonly legacyPolicyScope?: "thread" | "project" | "settings";
}): StrictResolution {
  const full = input.executionPolicy === "full-access";
  const candidates = [
    {
      source: "thread" as const,
      value: input.thread?.strict,
      legacy: input.thread?.fullAccessSandbox,
    },
    {
      source: "project" as const,
      value: input.project?.defaultStrict,
      legacy: input.project?.defaultFullAccessSandbox,
    },
    {
      source: "settings" as const,
      value: input.settings?.defaultStrict,
      legacy: input.settings?.defaultFullAccessSandbox,
    },
  ];
  for (const candidate of candidates) {
    if (candidate.value !== undefined)
      return { enabled: candidate.value, source: candidate.source, legacy: false };
    // Old Full-access defaults were copied at thread creation, not inherited
    // live. Applying them again would re-enable protection on old opt-outs.
    const legacyDefaultApplies = input.thread === undefined || candidate.source === "thread";
    if (
      (full && legacyDefaultApplies && candidate.legacy === true) ||
      candidate.source === input.legacyPolicyScope
    )
      return { enabled: true, source: candidate.source, legacy: true };
  }
  return { enabled: false, source: "default", legacy: false };
}
