import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createThreadSecretFiles } from "./threadSecretFiles";

const THREAD = "00000000-0000-4000-8000-000000000001";
let base: string;
let root: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "octant-thread-secrets-")));
  root = join(base, "thread-secrets");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("a thread secret's file", () => {
  it("has no name until it is committed, and holds the value exactly", () => {
    const prepared = createThreadSecretFiles({ root }).prepare(THREAD, "TOKEN", "  spaces kept \n");
    expect(existsSync(prepared.path)).toBe(false);
    prepared.commit();
    expect(prepared.path).toBe(join(root, THREAD, "TOKEN"));
    expect(readFileSync(prepared.path, "utf8")).toBe("  spaces kept \n");
  });

  it.runIf(process.platform !== "win32")("is readable by its owner alone", () => {
    mkdirSync(root, { mode: 0o755 });
    const prepared = createThreadSecretFiles({ root }).prepare(THREAD, "TOKEN", "value");
    prepared.commit();
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(root, THREAD)).mode & 0o777).toBe(0o700);
    expect(lstatSync(prepared.path).mode & 0o777).toBe(0o600);
  });

  it("leaves nothing behind when it is discarded", () => {
    const prepared = createThreadSecretFiles({ root }).prepare(THREAD, "TOKEN", "value");
    prepared.discard();
    expect(existsSync(prepared.path)).toBe(false);
    expect(existsSync(`${prepared.path}.partial`)).toBe(false);
  });

  it("replaces an earlier file whole", () => {
    const files = createThreadSecretFiles({ root });
    files.prepare(THREAD, "TOKEN", "a much longer first value").commit();
    files.prepare(THREAD, "TOKEN", "second").commit();
    expect(readFileSync(join(root, THREAD, "TOKEN"), "utf8")).toBe("second");
  });

  it.each([
    ["..", "TOKEN"],
    ["a/b", "TOKEN"],
    [THREAD, "../TOKEN"],
    [THREAD, "token"],
    [THREAD, "TOKEN.partial"],
  ])("refuses to write for thread %j and name %j", (threadId, name) => {
    expect(() => createThreadSecretFiles({ root }).prepare(threadId, name, "value")).toThrow();
    expect(existsSync(root)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("refuses a folder that is a link", () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(root);
    symlinkSync(elsewhere, join(root, THREAD));
    expect(() => createThreadSecretFiles({ root }).prepare(THREAD, "TOKEN", "value")).toThrow();
    expect(existsSync(join(elsewhere, "TOKEN.partial"))).toBe(false);
  });

  it("gives the earlier file back when it is discarded after it was put in place", () => {
    const files = createThreadSecretFiles({ root });
    const first = files.prepare(THREAD, "TOKEN", "first");
    first.commit();
    first.settle();
    const second = files.prepare(THREAD, "TOKEN", "second");
    second.commit();
    second.discard();
    expect(readFileSync(join(root, THREAD, "TOKEN"), "utf8")).toBe("first");
    expect(readdirSync(join(root, THREAD))).toEqual(["TOKEN"]);
  });

  it("keeps nothing of the earlier file once the new one is settled", () => {
    const files = createThreadSecretFiles({ root });
    files.prepare(THREAD, "TOKEN", "first").commit();
    const second = files.prepare(THREAD, "TOKEN", "second");
    second.commit();
    second.settle();
    expect(readdirSync(join(root, THREAD))).toEqual(["TOKEN"]);
  });

  it("is not stopped by a folder left where its file belongs", () => {
    for (const name of ["TOKEN", "TOKEN.partial", "TOKEN.previous"])
      mkdirSync(join(root, THREAD, name, "inside"), { recursive: true });
    const prepared = createThreadSecretFiles({ root }).prepare(THREAD, "TOKEN", "value");
    prepared.commit();
    prepared.settle();
    expect(readFileSync(prepared.path, "utf8")).toBe("value");
    expect(readdirSync(join(root, THREAD))).toEqual(["TOKEN"]);
  });

  it.runIf(process.platform !== "win32")("neither writes nor removes through a link", () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(join(elsewhere, THREAD), { recursive: true });
    writeFileSync(join(elsewhere, "TOKEN"), "kept");
    mkdirSync(root);
    symlinkSync(elsewhere, join(root, THREAD));
    const files = createThreadSecretFiles({ root });
    expect(() => files.remove(THREAD, "TOKEN")).toThrow();
    files.sweep();
    expect(readFileSync(join(elsewhere, "TOKEN"), "utf8")).toBe("kept");
    const shared = join(base, "thread-secrets");
    rmSync(shared, { recursive: true });
    symlinkSync(elsewhere, shared);
    const hostRoot = createThreadSecretFiles({ root: join(shared, "host") });
    expect(() => hostRoot.prepare(THREAD, "TOKEN", "value")).toThrow();
    expect(() => hostRoot.sweep()).toThrow();
  });

  it("removes one secret, or every thread's", () => {
    const files = createThreadSecretFiles({ root });
    files.prepare(THREAD, "ONE", "1").commit();
    files.prepare(THREAD, "TWO", "2").commit();
    files.remove(THREAD, "ONE");
    files.remove(THREAD, "ONE");
    expect(existsSync(join(root, THREAD, "ONE"))).toBe(false);
    expect(existsSync(join(root, THREAD, "TWO"))).toBe(true);
    files.sweep();
    // The folder itself stays, for a sandbox to cover.
    expect(readdirSync(root)).toEqual([]);
  });
});
