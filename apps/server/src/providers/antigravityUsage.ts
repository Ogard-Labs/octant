import { execFile } from "node:child_process";
import type { ProviderInstanceId, ProviderRateLimitWindow, UtcTimestamp } from "@octant/contracts";
import type { ProviderContextFactsSource } from "@octant/provider-sdk/context-facts";
import { Effect } from "effect";
import {
  accountUsageFailure,
  accountWindowLimits,
  type AccountUsageReadings,
  isRecord,
  readAccountUsage,
  resetTimestamp,
  sharedAccountUsageReadings,
  usedPercentWindow,
} from "./accountUsageEndpoint";

/** The CLI's own usage command, as other ACP clients of it read limits. */
export const ANTIGRAVITY_USAGE_ARGS = ["-p", "/usage", "--output-format", "json"] as const;
const USAGE_TIMEOUT_MS = 18_000;
const USAGE_OUTPUT_BYTES = 1_048_576;

export interface AntigravityUsageOptions {
  readonly instanceId: ProviderInstanceId;
  /** The `agy` the instance runs; its usage command reads its own sign-in. */
  readonly binaryPath: string;
  readonly runUsage?: (binaryPath: string, args: ReadonlyArray<string>) => Promise<string>;
  readonly clock?: () => string;
  readonly readings?: AccountUsageReadings;
}

/**
 * Rolling windows from `agy -p /usage --output-format json`. Each group (the
 * Gemini models, the shared pool for other vendors' models) holds buckets
 * that say what fraction is left of a window and when it resets. A disabled
 * bucket has no figure and is left out; an answer that is not a successful
 * usage reading is refused rather than read as zero use.
 */
export function antigravityUsageWindows(
  body: unknown,
  observedAt: UtcTimestamp,
): ReadonlyArray<ProviderRateLimitWindow> | undefined {
  if (!isRecord(body) || body.status !== "SUCCESS") return undefined;
  const command = body.command;
  if (!isRecord(command) || !isRecord(command.data)) return undefined;
  const groups = command.data.groups;
  if (!Array.isArray(groups)) return undefined;
  const windows: ProviderRateLimitWindow[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) return undefined;
    const groupName = typeof group.name === "string" ? group.name.trim() : "";
    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) return undefined;
      if (bucket.disabled === true) continue;
      const left = bucket.remaining_fraction;
      if (left === null || left === undefined) continue;
      if (typeof left !== "number" || !Number.isFinite(left) || left < 0 || left > 1)
        return undefined;
      const span = typeof bucket.window === "string" ? bucket.window.trim() : "";
      const name = typeof bucket.name === "string" ? bucket.name.trim() : "";
      const label = [groupName, name || span].filter((part) => part.length > 0).join(" · ");
      if (label.length === 0) return undefined;
      const parsed = usedPercentWindow(
        label.slice(0, 64),
        (1 - left) * 100,
        resetTimestamp(bucket.reset_time),
        observedAt,
      );
      if (parsed === undefined) return undefined;
      windows.push(parsed);
    }
  }
  return windows;
}

function runUsageCommand(binaryPath: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      [...args],
      { timeout: USAGE_TIMEOUT_MS, maxBuffer: USAGE_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    );
  });
}

export function makeAntigravityUsageFacts(
  options: AntigravityUsageOptions,
): ProviderContextFactsSource {
  const runUsage = options.runUsage ?? runUsageCommand;
  const clock = options.clock ?? (() => new Date().toISOString());
  const readings = options.readings ?? sharedAccountUsageReadings;
  const readUsage = Effect.gen(function* () {
    const output = yield* Effect.tryPromise({
      try: () => runUsage(options.binaryPath, ANTIGRAVITY_USAGE_ARGS),
      catch: () =>
        accountUsageFailure(
          "unavailable",
          "Google Antigravity's usage command did not answer. Check that agy is signed in.",
        ),
    });
    const body = yield* Effect.try({
      try: (): unknown => JSON.parse(output),
      catch: () =>
        accountUsageFailure("protocol", "Google Antigravity returned usage Octant cannot read."),
    });
    const observedAt = new Date(clock()).toISOString() as UtcTimestamp;
    const windows = antigravityUsageWindows(body, observedAt);
    if (windows === undefined || windows.length === 0) {
      return yield* Effect.fail(
        accountUsageFailure("protocol", "Google Antigravity returned usage Octant cannot read."),
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
            `antigravity:${String(options.instanceId)}:${options.binaryPath}`,
            readUsage,
            onDemand === true,
            () => Date.parse(clock()),
          ),
  };
}
