import type { ProviderToolDefinition } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { OpenCodeRetainedSessions, RememberedOpenCodeEdits } from "./openCodeRetainedSessions";

const tools = (name: string): ReadonlyArray<ProviderToolDefinition> => [
  { name, inputSchema: { type: "object" } },
];

describe("OpenCodeRetainedSessions", () => {
  it("drops the oldest catalogue past 128, keeping the recent and the new", () => {
    const retained = new OpenCodeRetainedSessions();
    for (let index = 0; index < 129; index += 1) {
      retained.rememberCatalog(`ses_${index}`, tools(`tool_${index}`));
    }

    expect(retained.catalog("ses_0")).toBeUndefined();
    expect(retained.catalog("ses_1")?.[0]?.name).toBe("tool_1");
    expect(retained.catalog("ses_128")?.[0]?.name).toBe("tool_128");
  });

  it("keeps a re-remembered catalogue newest instead of evicting it", () => {
    const retained = new OpenCodeRetainedSessions({ maxCatalogs: 2 });
    retained.rememberCatalog("a", tools("ta"));
    retained.rememberCatalog("b", tools("tb"));

    retained.rememberCatalog("a", tools("ta2"));
    retained.rememberCatalog("c", tools("tc"));

    expect(retained.catalog("b")).toBeUndefined();
    expect(retained.catalog("a")?.[0]?.name).toBe("ta2");
    expect(retained.catalog("c")?.[0]?.name).toBe("tc");
  });

  it("drops a catalogue whose resume never came within its lifetime", () => {
    let now = 1_000;
    const retained = new OpenCodeRetainedSessions({ now: () => now });
    retained.rememberCatalog("old", tools("stale"));

    now = 1_000 + 30 * 60_000 + 1;

    expect(retained.catalog("old")).toBeUndefined();
    // A miss hands a resume no tools, never another session's.
    expect(retained.catalog("other")).toBeUndefined();
  });

  it("keeps no slot for an empty catalogue, evicting nothing", () => {
    const retained = new OpenCodeRetainedSessions({ maxCatalogs: 2 });
    retained.rememberCatalog("a", tools("ta"));
    retained.rememberCatalog("b", tools("tb"));

    retained.rememberCatalog("empty", []);
    retained.rememberCatalog("c", tools("tc"));

    expect(retained.catalog("empty")).toBeUndefined();
    expect(retained.catalog("a")).toBeUndefined();
    expect(retained.catalog("b")?.[0]?.name).toBe("tb");
    expect(retained.catalog("c")?.[0]?.name).toBe("tc");
  });

  it("forgets a catalogue whose session OpenCode itself deleted", () => {
    const retained = new OpenCodeRetainedSessions();
    retained.rememberCatalog("gone", tools("x"));
    retained.markStale("gone");

    retained.sessionRemoved("gone");

    expect(retained.catalog("gone")).toBeUndefined();
    // The session is gone, not poisoned: a new native session may take its place.
    expect(retained.refusesResume("gone")).toBe(false);
  });

  it("drops the catalogue of a session that must never be resumed", () => {
    const retained = new OpenCodeRetainedSessions();
    retained.rememberCatalog("stale", tools("x"));

    retained.markStale("stale");

    expect(retained.catalog("stale")).toBeUndefined();
    expect(retained.refusesResume("stale")).toBe(true);
  });

  it("keeps refusing a stale session after its catalogue id is reused nowhere else", () => {
    const retained = new OpenCodeRetainedSessions();
    retained.markStale("stale");

    expect(retained.refusesResume("stale")).toBe(true);
    expect(retained.refusesResume("fresh")).toBe(false);
  });

  it("refuses an unknown resume once more tombstones than the cap were seen", () => {
    const retained = new OpenCodeRetainedSessions();
    for (let index = 0; index < 4097; index += 1) {
      retained.markStale(`ses_${index}`);
    }

    expect(retained.refusesResume("ses_0")).toBe(true);
    expect(retained.refusesResume("never-seen")).toBe(true);
  });
});

describe("RememberedOpenCodeEdits", () => {
  it("refuses a batch past 1024 whole, keeping every earlier grant", () => {
    const edits = new RememberedOpenCodeEdits();
    const files = Array.from({ length: 1024 }, (_, index) => `/p/f${index}.ts`);
    expect(edits.add(files)).toBe(true);

    expect(edits.add(["/p/extra.ts", "*"])).toBe(false);

    expect(edits.has("/p/f0.ts")).toBe(true);
    expect(edits.has("/p/f1023.ts")).toBe(true);
    expect(edits.has("/p/extra.ts")).toBe(false);
    expect(edits.has("*")).toBe(false);
  });

  it("counts a batch's repeated and already-held names once", () => {
    const edits = new RememberedOpenCodeEdits();
    const files = Array.from({ length: 1024 }, (_, index) => `/p/f${index}.ts`);
    expect(edits.add(files.slice(0, 1023))).toBe(true);

    // One new name, one held name, and one duplicate still fit the last slot.
    expect(edits.add(["/p/f0.ts", "/p/new.ts", "/p/new.ts"])).toBe(true);
    expect(edits.has("/p/new.ts")).toBe(true);
  });

  it("admits nothing new once its process is gone, and forgets what it held", () => {
    const edits = new RememberedOpenCodeEdits();
    edits.add(["/p/a.ts"]);

    edits.retire();

    expect(edits.has("/p/a.ts")).toBe(false);
    expect(edits.reserve(["/p/b.ts"])).toBeUndefined();
    expect(edits.add(["/p/b.ts"])).toBe(false);
    expect(edits.has("/p/b.ts")).toBe(false);
  });

  it("shows a reservation's names while its answer is in flight, then releases them on failure", () => {
    const edits = new RememberedOpenCodeEdits();
    const settle = edits.reserve(["/p/a.ts", "/p/b.ts"]);

    // The edit may stream in before the answer's RPC returns.
    expect(edits.has("/p/a.ts")).toBe(true);
    expect(edits.has("/p/b.ts")).toBe(true);

    settle?.(false);

    expect(edits.has("/p/a.ts")).toBe(false);
    expect(edits.has("/p/b.ts")).toBe(false);
  });

  it("keeps a name a succeeding grant shares when an overlapping one fails", () => {
    const edits = new RememberedOpenCodeEdits();
    const first = edits.reserve(["/p/a.ts", "/p/shared.ts"]);
    const second = edits.reserve(["/p/shared.ts", "/p/b.ts"]);

    second?.(true);
    first?.(false);

    expect(edits.has("/p/shared.ts")).toBe(true);
    expect(edits.has("/p/b.ts")).toBe(true);
    expect(edits.has("/p/a.ts")).toBe(false);
  });

  it("keeps a provider-settled name when a pending answer fails", () => {
    const edits = new RememberedOpenCodeEdits();
    const settle = edits.reserve(["/p/x.ts"]);

    expect(edits.add(["/p/x.ts"])).toBe(true);
    settle?.(false);

    expect(edits.has("/p/x.ts")).toBe(true);
  });

  it("releases only the failed reservation's own names", () => {
    const edits = new RememberedOpenCodeEdits();
    const failed = edits.reserve(["/p/a.ts", "/p/b.ts"]);
    const kept = edits.reserve(["/p/c.ts"]);

    failed?.(false);

    expect(edits.has("/p/a.ts")).toBe(false);
    expect(edits.has("/p/b.ts")).toBe(false);
    expect(edits.has("/p/c.ts")).toBe(true);

    kept?.(true);
    // A settle closure is one-use: settling again cannot take the name back.
    kept?.(false);
    expect(edits.has("/p/c.ts")).toBe(true);
  });

  it("changes nothing when a batch cannot fit", () => {
    const edits = new RememberedOpenCodeEdits();
    const files = Array.from({ length: 1024 }, (_, index) => `/p/f${index}.ts`);
    expect(edits.add(files)).toBe(true);

    expect(edits.reserve(["/p/f0.ts", "/p/overflow.ts"])).toBeUndefined();

    expect(edits.has("/p/overflow.ts")).toBe(false);
    expect(edits.has("/p/f0.ts")).toBe(true);
  });

  it("ignores a late settle after its process retired", () => {
    const edits = new RememberedOpenCodeEdits();
    const settle = edits.reserve(["/p/a.ts"]);

    edits.retire();
    settle?.(true);

    expect(edits.has("/p/a.ts")).toBe(false);
  });
});
