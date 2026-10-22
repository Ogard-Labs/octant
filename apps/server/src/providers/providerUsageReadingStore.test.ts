import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeProviderInstanceId,
  decodeProviderServiceLimits,
  type ProviderUsageLimitsEntry,
} from "@octant/contracts";
import { ProviderUsageReadingStore } from "./providerUsageReadingStore";

const instanceId = decodeProviderInstanceId("11111111-1111-4111-8111-111111111111");
const observedAt = "2026-10-11T12:00:00.000Z" as ProviderUsageLimitsEntry["observedAt"];

const reading: ProviderUsageLimitsEntry = {
  providerInstanceId: instanceId,
  status: "available",
  source: "provider-runtime",
  observedAt,
  limits: decodeProviderServiceLimits({
    providerInstanceId: instanceId,
    scope: "account",
    requests: { status: "unavailable" },
    tokens: { status: "unavailable" },
    concurrency: { status: "unavailable" },
    retry: { status: "inactive" },
    quota: "available",
    source: "runtime-reported",
    confidence: "high",
    updatedAt: observedAt,
    rateLimitWindows: [{ window: "five_hour", status: "allowed", utilization: 0.4, observedAt }],
  }),
};

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), "octant-usage-readings-"));
  const filePath = join(directory, "providers", "usage-readings.json");
  return { store: new ProviderUsageReadingStore(filePath), filePath };
}

describe("provider usage reading store", () => {
  it("gives back the readings a previous run saved, readable by its owner only", async () => {
    const { store, filePath } = await openStore();
    store.save([reading]);
    await store.flush();

    expect(await new ProviderUsageReadingStore(filePath).load()).toEqual([reading]);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("starts empty when the file is missing, unreadable, or from another version", async () => {
    const { store, filePath } = await openStore();
    expect(await store.load()).toEqual([]);

    store.save([reading]);
    await store.flush();
    await writeFile(filePath, "{ not json", "utf8");
    expect(await store.load()).toEqual([]);

    await writeFile(filePath, JSON.stringify({ version: 2, entries: [reading] }), "utf8");
    expect(await store.load()).toEqual([]);
  });

  it("skips a stored entry that no longer decodes and keeps the rest", async () => {
    const { store, filePath } = await openStore();
    store.save([reading]);
    await store.flush();
    const file = JSON.parse(await readFile(filePath, "utf8")) as { entries: unknown[] };
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, entries: [{ status: "available" }, ...file.entries] }),
      "utf8",
    );

    expect(await store.load()).toEqual([reading]);
  });
});
