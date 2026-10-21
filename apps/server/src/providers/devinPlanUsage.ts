import { readFile } from "node:fs/promises";
import type { ProviderInstanceId, ProviderRateLimitWindow, UtcTimestamp } from "@octant/contracts";
import type { ProviderContextFactsSource } from "@octant/provider-sdk/context-facts";
import { Effect } from "effect";
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

const DEFAULT_SERVER = "https://server.codeium.com";
const STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

export interface DevinPlanUsageOptions {
  readonly instanceId: ProviderInstanceId;
  /** Devin's own sign-in file, which its CLI writes and Octant only reads. */
  readonly credentialPath: string;
  readonly fetch?: AccountUsageFetch;
  readonly readText?: (path: string) => Promise<string>;
  readonly clock?: () => string;
  /** Where the last reading of each account is kept; shared across drivers by default. */
  readonly readings?: AccountUsageReadings;
}

interface DevinCredential {
  readonly apiKey: string;
  readonly server: string;
}

/**
 * The flat `key = "value"` lines Devin's credentials file holds. A server
 * other than an https URL is ignored, so a rewritten file cannot send the key
 * anywhere in the clear.
 */
export function parseDevinCredential(text: string): DevinCredential | undefined {
  let apiKey: string | undefined;
  let fallbackKey: string | undefined;
  let server: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*["']?([^"'\s]*)["']?\s*$/.exec(line);
    if (match === null) continue;
    const [, key = "", value = ""] = match;
    if (value.length === 0) continue;
    if (key === "windsurf_api_key") apiKey = value;
    else if (key === "api_key") fallbackKey = value;
    else if (key === "api_server_url" && value.startsWith("https://")) server = value;
  }
  const chosen = apiKey ?? fallbackKey;
  return chosen === undefined
    ? undefined
    : { apiKey: chosen, server: (server ?? DEFAULT_SERVER).replace(/\/+$/, "") };
}

/**
 * Daily and weekly windows from a GetUserStatus answer. The endpoint reports
 * what is left; ProtoJSON drops a zero, so a window with a reset instant and
 * no figure is fully used. The overage balance has no place in a rolling
 * window and is not shown.
 */
export function devinUsageWindows(
  body: unknown,
  observedAt: UtcTimestamp,
): ReadonlyArray<ProviderRateLimitWindow> | undefined {
  if (!isRecord(body) || !isRecord(body.userStatus)) return undefined;
  const plan = body.userStatus.planStatus;
  if (!isRecord(plan)) return undefined;
  const hideDaily = isRecord(plan.planInfo) && plan.planInfo.hideDailyQuota === true;
  const windows: ProviderRateLimitWindow[] = [];
  for (const [field, window] of [
    ["daily", "one_day"],
    ["weekly", "seven_day"],
  ] as const) {
    if (field === "daily" && hideDaily) continue;
    const rawRemaining = plan[`${field}QuotaRemainingPercent`];
    const rawReset = plan[`${field}QuotaResetAtUnix`];
    const remaining = numberField(rawRemaining);
    if (rawRemaining !== undefined && remaining === undefined) return undefined;
    const left = remaining ?? (rawReset === undefined ? undefined : 0);
    if (left === undefined) continue;
    const parsed = usedPercentWindow(window, 100 - left, resetTimestamp(rawReset), observedAt);
    if (parsed === undefined) return undefined;
    windows.push(parsed);
  }
  return windows;
}

export function makeDevinPlanUsageFacts(
  options: DevinPlanUsageOptions,
): ProviderContextFactsSource {
  const fetch = options.fetch ?? globalThis.fetch;
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const clock = options.clock ?? (() => new Date().toISOString());
  const readings = options.readings ?? sharedAccountUsageReadings;
  const readUsage = Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readText(options.credentialPath),
      catch: () => accountUsageFailure("unavailable", "Devin is not signed in."),
    });
    const credential = parseDevinCredential(text);
    if (credential === undefined) {
      return yield* Effect.fail(accountUsageFailure("unavailable", "Devin is not signed in."));
    }
    const body = yield* requestAccountUsage(
      fetch,
      "Devin",
      `${credential.server}${STATUS_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({
          metadata: {
            apiKey: credential.apiKey,
            ideName: "devin",
            ideVersion: "1.108.2",
            extensionName: "devin",
            extensionVersion: "1.108.2",
            locale: "en",
          },
        }),
      },
      () => Date.parse(clock()),
    );
    const observedAt = new Date(clock()).toISOString() as UtcTimestamp;
    const windows = devinUsageWindows(body, observedAt);
    // This status call is not a published interface. When its answer
    // stops matching, the reading fails instead of guessing at a shape.
    if (windows === undefined || windows.length === 0) {
      return yield* Effect.fail(
        accountUsageFailure("protocol", "Devin returned usage Octant cannot read."),
      );
    }
    return accountWindowLimits(options.instanceId, windows, observedAt);
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
            `devin:${String(options.instanceId)}:${options.credentialPath}`,
            readUsage,
            onDemand === true,
            () => Date.parse(clock()),
          ),
  };
}
