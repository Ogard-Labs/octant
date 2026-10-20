import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProviderInstanceId } from "@octant/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "../persistence/sqlitePort";
import { makeOpenCodeGoUsageFacts } from "./openCodeGoUsage";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-0000000000c1");
const clock = () => "2026-10-20T12:00:00.000Z";

// The usage endpoint answers with the share already used, in percent.
const usageAnswer = {
  usage: {
    rolling: { percent: 0.5, resetsAt: "2026-10-20T15:00:00Z" },
    weekly: { percent: 82, resetsAt: "2026-10-26T00:00:00Z" },
    monthly: { percent: 100, resetsAt: "2026-11-01T00:00:00Z" },
  },
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function dataDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "octant-opencode-go-"));
  directories.push(directory);
  return directory;
}

function writeCredentialDatabase(
  path: string,
  rows: ReadonlyArray<{ integration: string; key: string }>,
) {
  const database = openSqlite(path);
  database.exec(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)",
  );
  rows.forEach((row, index) => {
    database
      .prepare("INSERT INTO credential VALUES (?, ?, ?, 1, ?)")
      .run(`credential-${index}`, row.integration, JSON.stringify({ key: row.key }), index);
  });
  database.close();
}

function recordingFetch(response: () => Response) {
  const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  return {
    requests,
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return response();
    },
  };
}

function observe(facts: ReturnType<typeof makeOpenCodeGoUsageFacts>) {
  return Effect.runPromise(
    Effect.scoped(Effect.either(facts.observeServiceLimits({ instanceId }))),
  );
}

describe("OpenCode Go plan usage", () => {
  it("shows the 5-hour, weekly, and monthly windows for the Go key OpenCode 2 saved", async () => {
    const directory = dataDirectory();
    writeCredentialDatabase(join(directory, "opencode.db"), [
      { integration: "anthropic", key: "other-provider-key" },
      { integration: "opencode-go", key: "go-key-1" },
    ]);
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({ "opencode-go": { key: "stale" } }),
    );
    const http = recordingFetch(() => Response.json(usageAnswer));

    const outcome = await observe(
      makeOpenCodeGoUsageFacts({ instanceId, dataDirectory: directory, clock, fetch: http.fetch }),
    );

    expect(outcome._tag).toBe("Right");
    if (outcome._tag !== "Right") return;
    expect(outcome.right.quota).toBe("exhausted");
    expect(outcome.right.rateLimitWindows).toEqual([
      {
        window: "five_hour",
        status: "allowed",
        utilization: 0.005,
        resetsAt: "2026-10-20T15:00:00.000Z",
        observedAt: clock(),
      },
      {
        window: "seven_day",
        status: "warning",
        utilization: 0.82,
        resetsAt: "2026-10-26T00:00:00.000Z",
        observedAt: clock(),
      },
      {
        window: "monthly",
        status: "exhausted",
        utilization: 1,
        resetsAt: "2026-11-01T00:00:00.000Z",
        observedAt: clock(),
      },
    ]);
    expect(http.requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(new Headers(http.requests[0]?.init.headers).get("authorization")).toBe(
      "Bearer go-key-1",
    );
  });

  it("falls back to auth.json only when no database keeps sign-ins", async () => {
    const directory = dataDirectory();
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({ "opencode-go": { key: "go-key-2" } }),
    );
    const http = recordingFetch(() => Response.json(usageAnswer));

    await observe(
      makeOpenCodeGoUsageFacts({ instanceId, dataDirectory: directory, clock, fetch: http.fetch }),
    );

    expect(new Headers(http.requests[0]?.init.headers).get("authorization")).toBe(
      "Bearer go-key-2",
    );
  });

  it("says plan limits do not apply when OpenCode has no Go sign-in", async () => {
    const directory = dataDirectory();
    writeCredentialDatabase(join(directory, "opencode.db"), [
      { integration: "anthropic", key: "other-provider-key" },
    ]);
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({ "opencode-go": { key: "stale" } }),
    );
    const http = recordingFetch(() => Response.json(usageAnswer));

    const outcome = await observe(
      makeOpenCodeGoUsageFacts({ instanceId, dataDirectory: directory, clock, fetch: http.fetch }),
    );

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "unsupported" } });
    expect(http.requests).toHaveLength(0);
  });

  it("reports OpenCode not signed in without calling out when its data directory is missing", async () => {
    const http = recordingFetch(() => Response.json(usageAnswer));

    const outcome = await observe(
      makeOpenCodeGoUsageFacts({
        instanceId,
        dataDirectory: join(dataDirectory(), "missing"),
        clock,
        fetch: http.fetch,
      }),
    );

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "unavailable" } });
    expect(http.requests).toHaveLength(0);
  });

  it("fails as a protocol change, without the key, when the answer stops matching", async () => {
    const directory = dataDirectory();
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({ "opencode-go": { key: "go-key-3" } }),
    );
    const http = recordingFetch(() => Response.json({ usage: { rolling: { percent: 250 } } }));

    const outcome = await observe(
      makeOpenCodeGoUsageFacts({ instanceId, dataDirectory: directory, clock, fetch: http.fetch }),
    );

    expect(outcome).toMatchObject({ _tag: "Left", left: { category: "protocol" } });
    expect(JSON.stringify(outcome)).not.toContain("go-key-3");
  });
});
