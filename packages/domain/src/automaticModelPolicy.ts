import type { ProviderReadiness } from "@octant/contracts";

/**
 * The jobs Octant runs on a model without the person typing: Octant Shield's
 * Judge and person memory's distilling. Each job is told apart in Settings,
 * the journal and Usage by this name.
 */
export type AutomaticModelJob = "shield-judge" | "person-memory";

export const AUTOMATIC_MODEL_JOB_LABELS: Readonly<Record<AutomaticModelJob, string>> = {
  "shield-judge": "Octant Shield's Judge",
  "person-memory": "Memory distilling",
};

/**
 * What the person is told about where an automatic call goes. It names the
 * content that leaves and the provider that receives it, and says the choice
 * is the person's alone.
 */
export const AUTOMATIC_MODEL_DISCLOSURE: Readonly<Record<AutomaticModelJob, string>> = {
  "shield-judge":
    "What the Judge reviews goes to this provider: your recent messages, the pending action and the project's root. It never sees files, tool output or web pages.",
  "person-memory":
    "What memory distils goes to this provider: the title of a finished thread, the messages you wrote in it and the memories already kept (so it does not repeat them), with secrets removed. It never sees answers, tool output or files.",
};

/** Settings' note for both jobs: one choice, no automatic switching. */
export const AUTOMATIC_MODEL_NO_SWITCH_NOTE =
  "Octant never moves a job to another account by itself. If the account you chose is off or at its limit, the Judge asks you and memory waits.";

/**
 * What stands between an account the person chose and a call on it, as one
 * plain sentence, or undefined when the call may go ahead. There is no
 * alternative to offer: the caller asks the person (the Judge) or waits
 * (distilling), and never picks another account.
 */
export function automaticModelUnavailableReason(input: {
  /** Absent when the account was removed. */
  readonly instance: { readonly enabled: boolean; readonly displayName?: string } | undefined;
  readonly readiness: ProviderReadiness | undefined;
  /** A usage window the provider reported as spent, not yet reset. */
  readonly atLimit: boolean;
}): string | undefined {
  if (input.instance === undefined) return "The account you chose was removed.";
  const name = input.instance.displayName ?? "The account you chose";
  if (!input.instance.enabled) return `${name} is turned off.`;
  if (input.atLimit) return `${name} is at its usage limit.`;
  if (
    input.readiness === "unavailable" ||
    input.readiness === "unauthenticated" ||
    input.readiness === "incompatible"
  ) {
    return `${name} is not ready.`;
  }
  return undefined;
}
