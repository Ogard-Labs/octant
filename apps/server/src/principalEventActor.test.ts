import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { eventActorForPrincipal } from "./principalEventActor";

const SOURCE_ROOT = import.meta.dirname;

/** What a module calls when it judges a device the host's own person paired as that person. */
const JUDGES_A_DEVICE_AS_THE_PERSON =
  /\b(principalActsAsHostPerson|principalAuthorityKind|boundPrincipalIsRestricted)\b/;

/**
 * Modules that judge such a device without resolving its actor themselves,
 * each with where the actor is named instead. A new module belongs here only
 * with a reason a reader can check.
 */
const NAMES_THE_ACTOR_ELSEWHERE: Readonly<Record<string, string>> = {
  "clientPrincipal.ts": "defines the judgement",
  "principalRouteContext.ts": "defines the judgement for a bound request",
  "authenticatedProductRoutes.ts": "dispatches only; each route it hands to resolves its own",
  "automation/automationRoutes.ts": "hands the principal to the command service, which resolves it",
  "designSystemRoutes.ts": "reads and saves a file in the person's folder; journals nothing",
  "externalContentRoutes.ts": "builds the device actor from the principal where it clears a mark",
  "harness/nativeHarnessEgressRoutes.ts": "hands the device to the rules store, which journals it",
  "localUsageHistoryRoutes.ts": "reads provider history; changes nothing",
  "localWindowReadRoute.ts": "a parameterless read; changes nothing",
  "serverProjects/serverProjectRoutes.ts":
    "a device only reads the catalog; its changes stay with a local window",
  "serverProjects/serverResourceRoutes.ts": "reads a server's load; changes nothing",
  "workFileListingRoutes.ts": "lists a folder's entries; changes nothing",
  "providers/providerUsageLimitsRoutes.ts":
    "reads the limits and asks the providers again; journals nothing",
  "terminalSessionRoutes.ts": "lists and reads history; changes nothing",
  "remote/remoteHttpAuthentication.ts":
    "answers a device's read of its own standing; that route journals nothing",
  "terminalSessions/terminalSessionAuthority.ts": "an authority predicate; changes nothing",
  "threadDocumentDeliveryAuthority.ts": "an authority predicate; changes nothing",
};

/**
 * A device's actor written out by hand, with what it gives as the actor id
 * and as the device id.
 */
const HAND_BUILT_DEVICE_ACTOR =
  /kind:\s*"remote-device",\s*actorId:\s*([^\n]+?),\s*deviceId:\s*([^\n]+?),?\s*\}/g;

/** The value inside the decoders and `String` a module wraps an id in. */
function unwrapped(expression: string): string {
  let value = expression.trim();
  for (;;) {
    const inner = /^(?:String|decode\w+)\((.*)\)$/s.exec(value)?.[1];
    if (inner === undefined) return value;
    value = inner.trim();
  }
}

function sourceModules(directory: string): ReadonlyArray<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceModules(path);
    return entry.name.endsWith(".ts") && !/\.(test|smoke|benchmark)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe("the actor a request's change is journaled with", () => {
  it("names a paired device by its id and every other request as the local person", () => {
    const deviceId = "71000000-0000-4000-8000-0000000000de";
    expect(eventActorForPrincipal({ kind: "remote-device", deviceId })).toEqual({
      kind: "remote-device",
      actorId: deviceId,
      deviceId,
    });
    expect(eventActorForPrincipal({ kind: "local-window" }).kind).toBe("local-user");
    expect(eventActorForPrincipal(undefined).kind).toBe("local-user");
  });

  it("is resolved by every module that judges a paired device as the person, or the module says where it is", () => {
    const judging = sourceModules(SOURCE_ROOT)
      .filter((path) => JUDGES_A_DEVICE_AS_THE_PERSON.test(readFileSync(path, "utf8")))
      .map((path) => ({
        module: relative(SOURCE_ROOT, path).replaceAll("\\", "/"),
        resolvesActor: readFileSync(path, "utf8").includes("eventActorForPrincipal"),
      }));
    const accounted = new Set(Object.keys(NAMES_THE_ACTOR_ELSEWHERE));

    // A route that lets a paired device act as the person and forgets who
    // acted journals the local person for the device's change.
    expect(
      judging
        .filter((entry) => !entry.resolvesActor && !accounted.has(entry.module))
        .map((entry) => entry.module),
    ).toEqual([]);
    // An entry that no longer applies is removed, so the lists stay true.
    const stillJudging = new Map(judging.map((entry) => [entry.module, entry.resolvesActor]));
    expect([...accounted].filter((module) => stillJudging.get(module) !== false)).toEqual([]);
  });

  it("names a device by its own id wherever a module writes a device's actor out by hand", () => {
    // One device must read as one actor across every record. A restricted
    // device's egress answers were once journaled under the local person's
    // actor id while the same device's other records used its own.
    const mismatched = sourceModules(SOURCE_ROOT).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(HAND_BUILT_DEVICE_ACTOR)]
        .filter((match) => {
          const actorId = unwrapped(match[1] ?? "");
          const deviceId = unwrapped(match[2] ?? "");
          // Copying an actor a caller already resolved keeps its scheme.
          const copied =
            actorId.endsWith(".actorId") &&
            deviceId === `${actorId.slice(0, -".actorId".length)}.deviceId`;
          return actorId !== deviceId && !copied;
        })
        .map(() => relative(SOURCE_ROOT, path).replaceAll("\\", "/")),
    );
    expect(mismatched).toEqual([]);
  });
});
