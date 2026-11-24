import {
  THREAD_SECRET_ENVIRONMENT_PREFIX,
  type ThreadSecretDelivery,
  type ThreadSecretKind,
  type ThreadSecretLifetime,
  type ThreadSecretRequestedDelivery,
} from "@octant/contracts/thread-secrets";

export interface ThreadSecretSetting {
  readonly mode: "chat" | "work" | "code";
  readonly strict: boolean;
  readonly kind: ThreadSecretKind;
}

export type ThreadSecretOffer =
  | { readonly status: "unsupported-mode" }
  | {
      readonly status: "offered";
      readonly lifetimes: ReadonlyArray<ThreadSecretLifetime>;
      readonly defaultLifetime: ThreadSecretLifetime;
    };

export type ThreadSecretLifetimeDecision =
  | { readonly status: "allowed"; readonly lifetime: ThreadSecretLifetime }
  | {
      readonly status: "refused";
      readonly failure: "unsupported-mode" | "refused-by-strict" | "lifetime-not-offered";
    };

export interface ThreadSecretDeliveryName {
  readonly field: string;
  readonly secretName: string;
  readonly environmentName: string;
}

const LIFETIMES: ReadonlyArray<ThreadSecretLifetime> = [
  "this-command",
  "this-turn",
  "1-hour",
  "24-hours",
  "until-archived",
  "remember",
];
const NOT_UNDER_STRICT: ReadonlySet<ThreadSecretLifetime> = new Set(["24-hours", "remember"]);

/** An account password unlocks the whole computer, so Octant never keeps one past its thread. */
function kindKeeps(kind: ThreadSecretKind, lifetime: ThreadSecretLifetime): boolean {
  return kind !== "account-password" || lifetime !== "remember";
}

/** Chat runs no commands, so a secret there has nothing to reach. */
function runsCommands(mode: ThreadSecretSetting["mode"]): boolean {
  return mode === "work" || mode === "code";
}

/** The lifetimes a card shows, and the one it starts on. */
export function resolveThreadSecretOffer(
  input: ThreadSecretSetting & {
    /** What the person chose the last time this name was asked for. */
    readonly lastLifetime?: ThreadSecretLifetime | undefined;
  },
): ThreadSecretOffer {
  if (!runsCommands(input.mode)) return { status: "unsupported-mode" };
  const lifetimes = LIFETIMES.filter(
    (lifetime) =>
      kindKeeps(input.kind, lifetime) && !(input.strict && NOT_UNDER_STRICT.has(lifetime)),
  );
  const last = input.lastLifetime;
  const first = input.strict ? "this-turn" : "24-hours";
  return {
    status: "offered",
    lifetimes,
    defaultLifetime: last !== undefined && lifetimes.includes(last) ? last : first,
  };
}

/**
 * Whether an answer's lifetime still stands when it arrives. Strict and the
 * mode are read again then, so a card drawn before Strict was turned on grants
 * nothing Strict refuses.
 */
export function decideThreadSecretLifetime(
  setting: ThreadSecretSetting,
  lifetime: ThreadSecretLifetime,
): ThreadSecretLifetimeDecision {
  if (!runsCommands(setting.mode)) return { status: "refused", failure: "unsupported-mode" };
  if (!kindKeeps(setting.kind, lifetime))
    return { status: "refused", failure: "lifetime-not-offered" };
  if (setting.strict && NOT_UNDER_STRICT.has(lifetime))
    return { status: "refused", failure: "refused-by-strict" };
  return { status: "allowed", lifetime };
}

/**
 * How a saved secret reaches its use. A handle never reaches the agent's shell,
 * so Strict has no file to keep out of it.
 */
export function resolveThreadSecretDelivery(input: {
  readonly requested: ThreadSecretRequestedDelivery;
  readonly strict: boolean;
  readonly freshEachUse: boolean;
}): ThreadSecretDelivery {
  if (input.requested === "handle") return "handle";
  if (input.freshEachUse) return "op-run";
  return input.strict ? "environment" : "file-and-environment";
}

/** The file and variable names a request's fields become, in the order it named them. */
export function threadSecretDeliveries(
  name: string,
  fields: ReadonlyArray<string> | undefined,
): ReadonlyArray<ThreadSecretDeliveryName> {
  const delivery = (field: string, secretName: string): ThreadSecretDeliveryName => ({
    field,
    secretName,
    environmentName: `${THREAD_SECRET_ENVIRONMENT_PREFIX}${secretName}`,
  });
  return fields === undefined
    ? [delivery(name, name)]
    : fields.map((field) => delivery(field, `${name}_${field}`));
}
