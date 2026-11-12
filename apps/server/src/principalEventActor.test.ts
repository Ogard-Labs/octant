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
  "externalContentRoutes.ts": "builds the device actor from the principal where it clears a mark",
  "harness/nativeHarnessEgressRoutes.ts": "hands the device to the rules store, which journals it",
  "terminalSessionRoutes.ts": "lists and reads history; changes nothing",
  "remote/remoteHttpAuthentication.ts":
    "answers a device's read of its own standing; that route journals nothing",
  "terminalSessions/terminalSessionAuthority.ts": "an authority predicate; changes nothing",
  "threadDocumentDeliveryAuthority.ts": "an authority predicate; changes nothing",
};

/**
 * Modules whose changes still name their services' fixed actor for a device.
 * The list only shrinks: threading the actor through one removes it here.
 */
const STILL_NAMES_A_FIXED_ACTOR: ReadonlyArray<string> = ["browserAutomationRoutes.ts"];

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
    const accounted = new Set([
      ...Object.keys(NAMES_THE_ACTOR_ELSEWHERE),
      ...STILL_NAMES_A_FIXED_ACTOR,
    ]);

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
});
