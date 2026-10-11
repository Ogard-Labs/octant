import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makePersistenceLive } from "./persistence/persistenceService";
import { startOctantServer } from "./server";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const bridgeSecret = `${"B".repeat(42)}A`;
const listenerOrigin = "http://127.0.0.1:13773";

type Call = (path: string, init?: RequestInit) => Effect.Effect<Response>;

/**
 * Runs `body` against a real host whose listener is the canonical loopback
 * address. The caller in these tests is on loopback and sends the listener's
 * own Origin, which is what another OS user, an `ssh -L` forward, or a proxy
 * that rewrites Host looks like from the host's side.
 */
async function withHost(body: (call: Call) => Effect.Effect<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "octant-local-session-authority-"));
  directories.push(directory);
  let handler: ((request: Request) => Response | Promise<Response>) | undefined;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* startOctantServer({
          hostname: "127.0.0.1",
          port: 0,
          desktopBridgeSecret: bridgeSecret,
          serve: (options) => {
            handler = options.fetch;
            return { url: new URL(listenerOrigin), stop: () => undefined };
          },
        });
        const call: Call = (path, init = {}) =>
          Effect.promise(async () => {
            const response = await handler?.(new Request(`${listenerOrigin}${path}`, init));
            if (response === undefined) throw new Error(`No route answered ${path}.`);
            return response;
          });
        yield* body(call);
      }).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
    ),
  );
}

function mintLaunchToken(call: Call, origin: string) {
  return Effect.gen(function* () {
    const created = yield* call("/api/desktop/launch-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-octant-desktop-secret": bridgeSecret },
      body: JSON.stringify({
        windowId: randomUUID(),
        capability: randomBytes(32).toString("base64url"),
        origin,
      }),
    });
    expect(created.status).toBe(201);
    return ((yield* Effect.promise(() => created.json())) as { launchToken: string }).launchToken;
  });
}

function exchange(call: Call, launchToken: string, origin: string) {
  return call("/api/shell/launch-session", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ launchToken }),
  });
}

function shellBootstrap(call: Call, capability: string) {
  return call("/api/shell/bootstrap", {
    method: "POST",
    headers: { origin: listenerOrigin, "x-octant-window-capability": capability },
  });
}

describe("local window authority requires a secret only the host's OS user can read", () => {
  it("gives a loopback caller with an admitted Origin but no token or bridge secret no capability", async () => {
    await withHost((call) =>
      Effect.gen(function* () {
        const session = yield* call("/api/shell/local-session", {
          method: "POST",
          headers: { "content-type": "application/json", origin: listenerOrigin },
          body: "{}",
        });
        expect(session.status).toBe(401);
        expect(yield* Effect.promise(() => session.json())).not.toHaveProperty("capability");

        const created = yield* call("/api/desktop/launch-sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            windowId: randomUUID(),
            capability: randomBytes(32).toString("base64url"),
            origin: listenerOrigin,
          }),
        });
        expect(created.status).toBe(401);

        const providers = yield* call("/api/providers/bootstrap", {
          headers: { origin: listenerOrigin },
        });
        expect(providers.status).toBe(401);
      }),
    );
  });

  it("refuses a launch token once it has been used", async () => {
    await withHost((call) =>
      Effect.gen(function* () {
        const launchToken = yield* mintLaunchToken(call, listenerOrigin);
        const first = yield* exchange(call, launchToken, listenerOrigin);
        expect(first.status).toBe(200);
        const authority = (yield* Effect.promise(() => first.json())) as { capability: string };
        expect((yield* shellBootstrap(call, authority.capability)).status).toBe(200);

        const replay = yield* exchange(call, launchToken, listenerOrigin);
        expect(replay.status).toBe(400);
        expect(yield* Effect.promise(() => replay.json())).not.toHaveProperty("capability");
      }),
    );
  });

  it("refuses a launch token minted for one origin when another origin presents it", async () => {
    await withHost((call) =>
      Effect.gen(function* () {
        const launchToken = yield* mintLaunchToken(call, listenerOrigin);
        const elsewhere = yield* exchange(call, launchToken, "http://localhost:13773");
        expect(elsewhere.status).toBe(400);
        expect(yield* Effect.promise(() => elsewhere.json())).not.toHaveProperty("capability");
      }),
    );
  });
});
