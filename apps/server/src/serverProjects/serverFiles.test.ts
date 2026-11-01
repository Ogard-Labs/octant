import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerConnection } from "./serverConnection";
import { ServerFileSystem } from "./serverFiles";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

describe.skipIf(!canRunThrowawaySshd)("the harness's file tools on a server folder", () => {
  let sshd: ThrowawaySshd;
  let connection: ServerConnection;
  let root = "";
  let outside = "";

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    connection = new ServerConnection({
      agentSocket: () => sshd.agentSocket,
      configFile: sshd.configFile,
    });
    root = join(sshd.root, "app");
    outside = join(sshd.root, "elsewhere");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, ".ssh"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(
      join(root, "src", "main.ts"),
      "const greeting = 'hello';\nexport default greeting;\n",
    );
    writeFileSync(join(root, "README.md"), "# App\nhello there\n");
    writeFileSync(join(root, ".git", "config"), "hello from git\n");
    writeFileSync(join(root, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
    writeFileSync(join(outside, "secret.txt"), "outside the folder\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "link-out.txt"));
    symlinkSync(outside, join(root, "dir-out"));
  }, 30_000);

  afterAll(() => sshd?.stop());

  const files = (alias = () => sshd.alias) =>
    new ServerFileSystem({
      connection,
      server: () => ({ alias: alias(), user: sshd.user }),
      root,
    });

  it("reads a file and lists a folder there", async () => {
    const tools = files();
    expect(await tools.read({ path: "src/main.ts" })).toMatchObject({
      kind: "file",
      path: "src/main.ts",
      lines: ["const greeting = 'hello';", "export default greeting;", ""],
    });
    const listing = await tools.read({ path: "." });
    expect(listing.kind === "directory" && listing.entries).toEqual(
      expect.arrayContaining([
        { name: "src", kind: "directory" },
        { name: "README.md", kind: "file" },
        { name: "link-out.txt", kind: "other" },
      ]),
    );
  });

  it("refuses a link out of the folder and a credential location, at any depth", async () => {
    const tools = files();
    expect(await tools.read({ path: "link-out.txt" })).toMatchObject({
      kind: "refused",
      reason: "path-escapes-root",
    });
    expect(await tools.read({ path: join(outside, "secret.txt") })).toMatchObject({
      reason: "path-escapes-root",
    });
    expect(await tools.read({ path: ".ssh/id_ed25519" })).toMatchObject({
      reason: "protected-file",
    });
    expect(await tools.write({ path: "dir-out/planted.txt", content: "x" })).toMatchObject({
      reason: "path-escapes-root",
    });
  });

  it("never carries a credential's bytes to this host, even through a link or a search", async () => {
    symlinkSync(join(root, ".ssh", "id_ed25519"), join(root, "innocent.txt"));
    const seen: string[] = [];
    const watched = new ServerFileSystem({
      connection: {
        run: async (server, input) => {
          const call = await connection.run(server, input);
          if (call.status !== "unreachable") seen.push(call.output.toString("utf8"));
          return call;
        },
      },
      server: () => ({ alias: sshd.alias, user: sshd.user }),
      root,
    });
    expect(await watched.read({ path: "innocent.txt" })).toMatchObject({
      reason: "protected-file",
    });
    await watched.grep({ pattern: "PRIVATE" });
    expect(seen.join("")).not.toContain("PRIVATE KEY");
  });

  it("writes a new file in a new folder, and edits only what it read, as it read it", async () => {
    const tools = files();
    expect(await tools.write({ path: "notes/today.md", content: "one\n" })).toMatchObject({
      kind: "written",
      path: "notes/today.md",
      created: true,
    });
    expect(readFileSync(join(root, "notes", "today.md"), "utf8")).toBe("one\n");

    expect(await tools.edit({ path: "README.md", oldText: "hello", newText: "hi" })).toMatchObject({
      reason: "not-read-first",
    });
    await tools.read({ path: "README.md" });
    expect(await tools.edit({ path: "README.md", oldText: "hello", newText: "hi" })).toMatchObject({
      kind: "edited",
      replacements: 1,
    });
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# App\nhi there\n");

    writeFileSync(join(root, "README.md"), "changed elsewhere\n");
    expect(await tools.edit({ path: "README.md", oldText: "changed", newText: "x" })).toMatchObject(
      { reason: "file-changed-since-read" },
    );
  });

  it("finds files and lines without entering Git's folder or returning credentials", async () => {
    const tools = files();
    const found = await tools.glob({ pattern: "**/*.ts" });
    expect(found).toEqual({ kind: "paths", paths: ["src/main.ts"], truncated: false });

    const matches = await tools.grep({ pattern: "hel+o" });
    expect(matches.kind === "matches" && matches.matches.map((match) => match.path)).toEqual([
      "src/main.ts",
    ]);
    const included = await tools.grep({ pattern: "greeting", include: "*.md" });
    expect(included.kind === "matches" && included.matches).toEqual([]);
    expect(await tools.grep({ pattern: "(" })).toMatchObject({ reason: "pattern-invalid" });
    // One file the server cannot read leaves the other matches standing.
    writeFileSync(join(root, "locked.txt"), "hello locked\n", { mode: 0o000 });
    const withLocked = await tools.grep({ pattern: "hel+o" });
    expect(withLocked.kind === "matches" && withLocked.matches.map((match) => match.path)).toEqual([
      "src/main.ts",
    ]);
    const keys = await tools.grep({ pattern: "PRIVATE" });
    expect(keys.kind === "matches" && keys.matches).toEqual([]);
  });

  it("reaches nothing, and changes nothing anywhere, when the server cannot be reached", async () => {
    const tools = files(() => sshd.closedAlias);
    expect(await tools.read({ path: "README.md" })).toMatchObject({
      kind: "refused",
      reason: "target-unavailable",
    });
    expect(await tools.write({ path: "offline.txt", content: "x" })).toMatchObject({
      reason: "target-unavailable",
    });
  });
});
