import type {
  AcpAgentAuthentication,
  ProviderInstanceId,
  ProviderRateLimitOverage,
  ProviderRateLimitWindow,
  UtcTimestamp,
} from "@octant/contracts";
import type { ProviderContextFactsSource } from "@octant/provider-sdk/context-facts";
import { Effect } from "effect";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import {
  accountUsageFailure,
  accountWindowLimits,
  type AccountUsageReadings,
  type AccountUsageFetch,
  isRecord,
  numberField,
  readAccountUsage,
  requestAccountUsage,
  resetTimestamp,
  sharedAccountUsageReadings,
  usedPercentWindow,
} from "./accountUsageEndpoint";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";
const SUBSCRIPTION_URL = "https://api.mistral.ai/v1/billing/subscription";

/**
 * The same Settings copy as the Vibe profile: Octant cannot read Vibe's own
 * Keychain item, so remaining quota waits on a Mistral API key saved there.
 */
const UNAVAILABLE_MESSAGE =
  "Mistral Vibe is not authenticated. Octant cannot read the key Vibe keeps in the macOS Keychain; switch this provider to API key authentication in Settings → Providers and enter a Mistral API key.";

const FORBIDDEN_USAGE = accountUsageFailure(
  "unsupported",
  "This account cannot view Vibe billing usage.",
);

const BEARER_HEADERS = (key: string): HeadersInit => ({
  Authorization: `Bearer ${key}`,
  Accept: "application/json",
});

export interface MistralVibeUsageOptions {
  readonly instanceId: ProviderInstanceId;
  readonly authentication?: AcpAgentAuthentication;
  readonly credentialResolver?: ProviderCredentialResolver;
  readonly fetch?: AccountUsageFetch;
  readonly clock?: () => string;
  /** Where the last reading of each account is kept; shared across drivers by default. */
  readonly readings?: AccountUsageReadings;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function paygOverage(enabled: boolean): ProviderRateLimitOverage {
  return { status: "allowed", disabledReason: enabled ? "Pay as you go on" : "Pay as you go off" };
}

/**
 * The monthly Vibe Code window from a billing/budget body. A missing or
 * zero `vibe_budget` is not an empty bar: the account has no allowance to
 * show. A body whose percentage cannot be read is refused as a protocol
 * change rather than clamped to 0%.
 */
export function mistralVibeUsageWindow(
  body: unknown,
  observedAt: UtcTimestamp,
  paygEnabled?: boolean,
): ProviderRateLimitWindow | "no-allowance" | undefined {
  if (!isRecord(body)) return undefined;
  const budget = body.vibe_budget;
  if (budget === undefined || budget === null) return "no-allowance";
  if (!isRecord(budget)) return undefined;
  const initial = numberField(budget.initial_budget);
  if (initial === undefined || initial <= 0) return "no-allowance";
  const used = numberField(budget.usage_percentage);
  if (used === undefined) return undefined;
  const parsed = usedPercentWindow("monthly", used, resetTimestamp(budget.reset_at), observedAt);
  if (parsed === undefined) return undefined;
  const payg = paygEnabled ?? booleanField(budget.payg_enabled);
  return payg === undefined ? parsed : { ...parsed, overage: paygOverage(payg) };
}

function vibeBudgetPaygEnabled(body: unknown): boolean | undefined {
  return isRecord(body) && isRecord(body.vibe_budget)
    ? booleanField(body.vibe_budget.payg_enabled)
    : undefined;
}

function vibeSubscriptionPaygEnabled(body: unknown): boolean | undefined {
  return isRecord(body) ? booleanField(body.vibe_payg_enabled) : undefined;
}

async function resolveVibeApiKey(options: MistralVibeUsageOptions): Promise<string | undefined> {
  if (options.authentication !== "api-key" || options.credentialResolver === undefined) {
    return undefined;
  }
  const present = await options.credentialResolver.has(String(options.instanceId));
  if (!present) return undefined;
  const credential = await options.credentialResolver.resolve(String(options.instanceId));
  const key = credential.trim();
  return key.length === 0 ? undefined : key;
}

export function makeMistralVibeUsageFacts(
  options: MistralVibeUsageOptions,
): ProviderContextFactsSource {
  const fetch = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? (() => new Date().toISOString());
  const readings = options.readings ?? sharedAccountUsageReadings;
  const now = () => Date.parse(clock());
  const readUsage = Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () => resolveVibeApiKey(options),
      catch: () => accountUsageFailure("unavailable", UNAVAILABLE_MESSAGE),
    });
    if (key === undefined) {
      return yield* Effect.fail(accountUsageFailure("unavailable", UNAVAILABLE_MESSAGE));
    }
    const body = yield* requestAccountUsage(
      fetch,
      "Mistral Vibe",
      BUDGET_URL,
      { method: "GET", headers: BEARER_HEADERS(key) },
      now,
      FORBIDDEN_USAGE,
    );
    const observedAt = new Date(clock()).toISOString() as UtcTimestamp;
    let payg = vibeBudgetPaygEnabled(body);
    if (payg === undefined) {
      const subscription = yield* Effect.either(
        requestAccountUsage(
          fetch,
          "Mistral Vibe",
          SUBSCRIPTION_URL,
          { method: "GET", headers: BEARER_HEADERS(key) },
          now,
        ),
      );
      if (subscription._tag === "Right") {
        payg = vibeSubscriptionPaygEnabled(subscription.right);
      }
    }
    const window =
      payg === undefined
        ? mistralVibeUsageWindow(body, observedAt)
        : mistralVibeUsageWindow(body, observedAt, payg);
    if (window === "no-allowance") {
      return yield* Effect.fail(
        accountUsageFailure("unsupported", "Mistral reported no monthly Vibe Code allowance."),
      );
    }
    if (window === undefined) {
      return yield* Effect.fail(
        accountUsageFailure("protocol", "Mistral Vibe returned usage Octant cannot read."),
      );
    }
    return accountWindowLimits(options.instanceId, [window], observedAt);
  });
  return {
    observeModelLimits: () => Effect.succeed([]),
    observeServiceLimits: ({ instanceId, onDemand }) =>
      String(instanceId) !== String(options.instanceId)
        ? Effect.fail(
            accountUsageFailure("invalid-configuration", "Provider instance does not match."),
          )
        : readAccountUsage(
            readings,
            `mistral-vibe:${String(options.instanceId)}`,
            readUsage,
            onDemand === true,
            now,
          ),
  };
}
