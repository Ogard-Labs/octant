import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateFeedKeyPair } from "./sign-update-feed";
import { replaceUpdatePublicKey, writeUpdatePublicKey } from "./write-update-public-key";

const FEED_SOURCE = join(import.meta.dirname, "../apps/desktop/src/appUpdateFeed.ts");
const WRITER = join(import.meta.dirname, "write-update-public-key.ts");

let directory: string;
let copy: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "octant-update-key-"));
  copy = join(directory, "appUpdateFeed.ts");
  await copyFile(FEED_SOURCE, copy);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("writing the update public key into the desktop source", () => {
  it("replaces the compiled-in key as the file is formatted today", async () => {
    const { publicKey } = generateFeedKeyPair();
    const before = await readFile(copy, "utf8");

    const result = await writeUpdatePublicKey(copy, publicKey);

    expect(result.status).toBe("written");
    const after = await readFile(copy, "utf8");
    expect(after).toContain(`"${publicKey}"`);
    // Only the key changes; the formatter's line break and everything else stay.
    const previous = /OCTANT_UPDATE_PUBLIC_KEY\s*=\s*"([^"]*)"/.exec(before)?.[1] ?? "";
    expect(after).toBe(before.replace(`"${previous}"`, `"${publicKey}"`));
  });

  it("replaces the key whether the constant sits on one line or two", () => {
    const { publicKey } = generateFeedKeyPair();
    const oneLine = 'export const OCTANT_UPDATE_PUBLIC_KEY = "old";\n';

    const result = replaceUpdatePublicKey(oneLine, publicKey);

    expect(result).toEqual({
      status: "replaced",
      source: `export const OCTANT_UPDATE_PUBLIC_KEY = "${publicKey}";\n`,
    });
  });

  it("refuses and leaves the file untouched when the constant cannot be found", async () => {
    const { publicKey } = generateFeedKeyPair();
    const renamed = 'export const SOME_OTHER_KEY =\n  "MCowBQYDK2VwAyEA";\n';
    await writeFile(copy, renamed);

    const result = await writeUpdatePublicKey(copy, publicKey);

    expect(result).toMatchObject({ status: "refused" });
    expect(await readFile(copy, "utf8")).toBe(renamed);
  });

  it("refuses a value that is not an Ed25519 public key", async () => {
    const before = await readFile(copy, "utf8");

    const result = await writeUpdatePublicKey(copy, "not-a-key");

    expect(result).toMatchObject({ status: "refused" });
    expect(await readFile(copy, "utf8")).toBe(before);
  });

  it("exits non-zero with a message naming the constant when it cannot write the key", async () => {
    const { publicKey } = generateFeedKeyPair();
    await writeFile(copy, "export const NOTHING_HERE = 1;\n");

    const run = spawnSync("bun", [WRITER, copy, publicKey], { encoding: "utf8" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("OCTANT_UPDATE_PUBLIC_KEY");
  });
});
