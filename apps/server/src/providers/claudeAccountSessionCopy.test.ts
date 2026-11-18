import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyClaudeAccountSession } from "./claudeAccountSessionCopy";
import { claudeProjectFolderName } from "./claudeProcess";

const sessionId = "6f1c2e2a-3b4d-4c5e-8f90-0a1b2c3d4e5f";

describe("copying a Claude session to another account", () => {
  let root: string;
  let from: string;
  let to: string;
  let projectRoot: string;
  let folder: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "octant-account-session-copy-"));
    from = join(root, "from-account");
    to = join(root, "to-account");
    projectRoot = join(root, "project");
    await Promise.all([mkdir(from), mkdir(to), mkdir(projectRoot)]);
    folder = claudeProjectFolderName((await realpath(projectRoot)).normalize("NFC"));
  });

  afterEach(async () => {
    await chmod(join(to, "file-history"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  async function put(base: string, path: string, content: string) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), content);
  }

  const transcript = () => join("projects", folder, `${sessionId}.jsonl`);
  const copy = (overrides: Partial<Parameters<typeof copyClaudeAccountSession>[0]> = {}) =>
    copyClaudeAccountSession({
      fromDirectory: from,
      toDirectory: to,
      projectRoot,
      sessionId,
      ...overrides,
    });

  it("copies the transcript, its own folder and its rewind checkpoints, owner-only", async () => {
    await put(from, transcript(), '{"type":"user"}\n');
    await put(from, join("projects", folder, sessionId, "subagents", "agent-1.jsonl"), "sub\n");
    await put(from, join("file-history", sessionId, "checkpoint@v1"), "before\n");
    await put(from, join("projects", folder, "other-session.jsonl"), "not this one\n");
    await put(from, ".credentials.json", "secret");

    const result = await copy();

    expect(result.status).toBe("copied");
    expect(await readFile(join(to, transcript()), "utf8")).toBe('{"type":"user"}\n');
    expect(
      await readFile(join(to, "projects", folder, sessionId, "subagents", "agent-1.jsonl"), "utf8"),
    ).toBe("sub\n");
    expect(await readFile(join(to, "file-history", sessionId, "checkpoint@v1"), "utf8")).toBe(
      "before\n",
    );
    expect((await stat(join(to, transcript()))).mode & 0o777).toBe(0o600);
    expect((await stat(join(to, "projects", folder))).mode & 0o077).toBe(0);
    await expect(stat(join(to, "projects", folder, "other-session.jsonl"))).rejects.toThrow();
    await expect(stat(join(to, ".credentials.json"))).rejects.toThrow();
  });

  it("skips a sign-in file found inside the session's folder without copying it", async () => {
    await put(from, transcript(), "t\n");
    await put(from, join("projects", folder, sessionId, "auth.json"), "secret");

    expect((await copy()).status).toBe("copied");
    await expect(stat(join(to, "projects", folder, sessionId, "auth.json"))).rejects.toThrow();
  });

  it("leaves an identical copy already in the new account as it is", async () => {
    await put(from, transcript(), "same\n");
    await put(to, transcript(), "same\n");

    expect((await copy()).status).toBe("copied");
  });

  it("refuses to overwrite a differing file in the new account", async () => {
    await put(from, transcript(), "theirs\n");
    await put(to, transcript(), "mine\n");

    expect(await copy()).toEqual({ status: "refused", reason: "destination-differs" });
    expect(await readFile(join(to, transcript()), "utf8")).toBe("mine\n");
  });

  it("refuses a session id that could name a path", async () => {
    await put(from, transcript(), "t\n");
    for (const id of ["../../etc/passwd", `${sessionId}/..`, "a/b", ""]) {
      expect(await copy({ sessionId: id })).toEqual({
        status: "refused",
        reason: "invalid-session-id",
      });
    }
  });

  it("refuses a symbolic link in the source session's folder", async () => {
    await put(from, transcript(), "t\n");
    await put(root, "elsewhere/secret.txt", "secret");
    await mkdir(join(from, "projects", folder, sessionId), { recursive: true });
    await symlink(
      join(root, "elsewhere", "secret.txt"),
      join(from, "projects", folder, sessionId, "linked"),
    );

    expect(await copy()).toEqual({ status: "refused", reason: "symbolic-link" });
    await expect(stat(join(to, transcript()))).rejects.toThrow();
  });

  it("refuses a transcript that is itself a link", async () => {
    await put(root, "elsewhere/transcript.jsonl", "t\n");
    await mkdir(join(from, "projects", folder), { recursive: true });
    await symlink(join(root, "elsewhere", "transcript.jsonl"), join(from, transcript()));

    expect(await copy()).toEqual({ status: "refused", reason: "symbolic-link" });
  });

  it("refuses a destination folder that is a link out of the new account", async () => {
    await put(from, transcript(), "t\n");
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), join(to, "projects"));

    expect(await copy()).toEqual({ status: "refused", reason: "symbolic-link" });
    await expect(stat(join(root, "elsewhere", folder))).rejects.toThrow();
  });

  it("refuses a session file that is another name for a file elsewhere", async () => {
    await put(from, transcript(), "t\n");
    await put(from, "sign-in.json", "secret");
    await mkdir(join(from, "projects", folder, sessionId));
    await link(join(from, "sign-in.json"), join(from, "projects", folder, sessionId, "saved"));

    expect(await copy()).toEqual({ status: "refused", reason: "unexpected-entry" });
  });

  it("refuses account directories that contain one another", async () => {
    await put(from, transcript(), "t\n");

    expect(await copy({ toDirectory: join(from, "nested") })).toMatchObject({ status: "refused" });
    await mkdir(join(from, "nested"));
    expect(await copy({ toDirectory: join(from, "nested") })).toEqual({
      status: "refused",
      reason: "account-directories-overlap",
    });
    expect(await copy({ toDirectory: from })).toEqual({
      status: "refused",
      reason: "account-directories-overlap",
    });
  });

  it("refuses when the session is not in the old account", async () => {
    expect(await copy()).toEqual({ status: "refused", reason: "session-missing" });
  });

  it("removes what it wrote when the copy fails part way", async () => {
    await put(from, transcript(), "t\n");
    await put(from, join("file-history", sessionId, "checkpoint@v1"), "before\n");
    await mkdir(join(to, "file-history"));
    await chmod(join(to, "file-history"), 0o500);

    expect(await copy()).toEqual({ status: "refused", reason: "copy-failed" });
    await expect(stat(join(to, transcript()))).rejects.toThrow();
    await expect(stat(join(to, "projects"))).rejects.toThrow();
  });

  it("discards a finished copy on request, leaving files it did not write", async () => {
    await put(from, transcript(), "t\n");
    await put(from, join("file-history", sessionId, "checkpoint@v1"), "before\n");
    await put(to, join("file-history", sessionId, "checkpoint@v1"), "before\n");

    const result = await copy();
    if (result.status !== "copied") throw new Error("Expected a copy.");
    await result.discard();

    await expect(stat(join(to, transcript()))).rejects.toThrow();
    expect(await readFile(join(to, "file-history", sessionId, "checkpoint@v1"), "utf8")).toBe(
      "before\n",
    );
  });
});
