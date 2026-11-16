import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { makePiNativeSessions, piSessionFolderName } from "./piNativeSessions";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000901");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000902");
const otherSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000903");
const modelId = "anthropic/claude-sonnet" as ProviderModelId;
const projectRoot = "/work/project";

function piSessions() {
  const base = mkdtempSync(join(tmpdir(), "octant-pi-native-"));
  const person = join(base, "person");
  const octant = join(base, "octant");
  mkdirSync(octant);
  const write = (root: string, id: string, name: string | undefined, modified: string) => {
    const folder = join(person, piSessionFolderName(root));
    mkdirSync(folder, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session", version: 3, id, timestamp: modified, cwd: root }),
      JSON.stringify({ type: "message", id: "a1", parentId: null, message: { role: "user" } }),
      ...(name === undefined
        ? []
        : [JSON.stringify({ type: "session_info", id: "a2", parentId: "a1", name })]),
    ];
    const path = join(folder, `${modified.replace(/[:.]/g, "-")}_${id}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  };
  return {
    person,
    octant,
    write,
    sessions: makePiNativeSessions({
      instanceId,
      octantSessionDirectory: octant,
      personSessionDirectory: person,
    }),
  };
}

describe("Pi native sessions", () => {
  it("offers the person's own Pi sessions in this folder, newest first and named, and none from another folder", async () => {
    const fixture = piSessions();
    fixture.write(projectRoot, "older", undefined, "2026-11-01T10:00:00.000Z");
    fixture.write(projectRoot, "newer", "Refactor auth", "2026-11-02T10:00:00.000Z");
    fixture.write("/work/other", "elsewhere", undefined, "2026-11-03T10:00:00.000Z");
    const listed = await Effect.runPromise(fixture.sessions.list({ instanceId, projectRoot }));
    expect(listed.map((session) => session.nativeSessionId).sort()).toEqual(["newer", "older"]);
    expect(listed.find((session) => session.nativeSessionId === "newer")?.title).toBe(
      "Refactor auth",
    );
  });

  it("takes up a session as a copy under the Octant session and leaves the person's file unchanged", async () => {
    const fixture = piSessions();
    const source = fixture.write(projectRoot, "mine", undefined, "2026-11-01T10:00:00.000Z");
    const before = readFileSync(source, "utf8");
    const cursor = await Effect.runPromise(
      fixture.sessions.adopt({
        instanceId,
        projectRoot,
        mode: "code",
        sessionId,
        nativeSessionId: "mine",
        modelId,
      }),
    );
    expect(cursor).toMatchObject({ driverKind: "pi", value: String(sessionId) });
    expect(cursor.binding).toMatchObject({ projectRoot, mode: "code", sessionId });
    expect(readFileSync(source, "utf8")).toBe(before);
    const [copy] = readdirSync(fixture.octant);
    expect(copy?.endsWith(`_${String(sessionId)}.jsonl`)).toBe(true);
    const [header, ...entries] = readFileSync(join(fixture.octant, copy!), "utf8").split("\n");
    expect(JSON.parse(header!)).toMatchObject({
      id: String(sessionId),
      cwd: projectRoot,
      parentSession: source,
    });
    expect(entries.join("\n")).toBe(before.split("\n").slice(1).join("\n"));
    // Held by a thread: no longer offered, and a second thread is refused it.
    expect(await Effect.runPromise(fixture.sessions.list({ instanceId, projectRoot }))).toEqual([]);
    const second = await Effect.runPromiseExit(
      fixture.sessions.adopt({
        instanceId,
        projectRoot,
        mode: "code",
        sessionId: otherSessionId,
        nativeSessionId: "mine",
        modelId,
      }),
    );
    expect(Exit.isFailure(second) && JSON.stringify(second.cause)).toContain(
      "already belongs to an Octant thread",
    );
  });

  it("refuses a session kept for another folder and offers a released one again", async () => {
    const fixture = piSessions();
    fixture.write("/work/other", "foreign", undefined, "2026-11-01T10:00:00.000Z");
    fixture.write(projectRoot, "mine", undefined, "2026-11-01T10:00:00.000Z");
    const foreign = await Effect.runPromiseExit(
      fixture.sessions.adopt({
        instanceId,
        projectRoot,
        mode: "work",
        sessionId,
        nativeSessionId: "foreign",
        modelId,
      }),
    );
    expect(Exit.isFailure(foreign) && JSON.stringify(foreign.cause)).toContain(
      "not one of this folder's",
    );
    await Effect.runPromise(
      fixture.sessions.adopt({
        instanceId,
        projectRoot,
        mode: "work",
        sessionId,
        nativeSessionId: "mine",
        modelId,
      }),
    );
    await Effect.runPromise(
      fixture.sessions.release!({ instanceId, nativeSessionId: "mine", sessionId }),
    );
    expect(readdirSync(fixture.octant)).toEqual([]);
    expect(
      (await Effect.runPromise(fixture.sessions.list({ instanceId, projectRoot }))).map(
        (session) => session.nativeSessionId,
      ),
    ).toEqual(["mine"]);
  });
});
