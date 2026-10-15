import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import type { ClaudeResumeIdentity } from "./claudeDriver";
import { ClaudeResumeIdentityJournal } from "./claudeResumeIdentityJournal";
import { ClaudeResumeIdentityStore } from "./claudeResumeIdentityStore";

const directories: string[] = [];
const now = "2026-10-15T09:30:00.000Z";
const providerInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000621");
const identity: ClaudeResumeIdentity = {
  providerInstanceId,
  octantSessionId: decodeProviderSessionId("80000000-0000-4000-8000-000000000622"),
  sdkSessionId: "sdk-session-one",
  projectRoot: "/tmp/octant-claude-resume",
  modelId: "claude-haiku" as ProviderModelId,
  authentication: "subscription",
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Each call is one host lifetime: a new store over the same journal. */
function hostLifetime<A>(
  directory: string,
  run: (store: ClaudeResumeIdentityStore) => Promise<A>,
): Promise<A> {
  let counter = 0;
  const uuid = () => `80000000-0000-4000-8000-${String(++counter + 9000).padStart(12, "0")}`;
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        const journal = new ClaudeResumeIdentityJournal({ persistence, uuid, clock: () => now });
        return yield* Effect.promise(() => run(new ClaudeResumeIdentityStore({ journal })));
      }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now }))),
    ),
  );
}

function newDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-claude-resume-"));
  directories.push(directory);
  return directory;
}

const lookup = (store: ClaudeResumeIdentityStore) =>
  store.lookup(
    { providerInstanceId, sdkSessionId: identity.sdkSessionId },
    new AbortController().signal,
  );

describe("Claude resume identity journal", () => {
  it("still resumes a Claude session after the host restarts", async () => {
    const directory = newDirectory();
    await hostLifetime(directory, (store) => store.put(identity, new AbortController().signal));

    await expect(hostLifetime(directory, lookup)).resolves.toEqual(identity);
  });

  it("refuses a session whose identity was removed before the host restarted", async () => {
    const directory = newDirectory();
    await hostLifetime(directory, async (store) => {
      const signal = new AbortController().signal;
      await store.put(identity, signal);
      await store.remove({ providerInstanceId, sdkSessionId: identity.sdkSessionId }, signal);
    });

    await expect(hostLifetime(directory, lookup)).resolves.toBeUndefined();
  });

  it("forgets every identity of a provider that was reconfigured, across a restart", async () => {
    const directory = newDirectory();
    await hostLifetime(directory, async (store) => {
      const signal = new AbortController().signal;
      await store.put(identity, signal);
      await store.removeProvider(providerInstanceId, signal);
    });

    await expect(hostLifetime(directory, lookup)).resolves.toBeUndefined();
  });
});
