import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeHarnessFileSystem } from "../harness/nativeHarnessFileSystem";
import { configureSecretGuardLocations, secretGuardRefusal } from "../process/secretGuard";
import { buildDenyDefaultSeatbeltProfile, seatbeltAllowRule } from "../process/seatbeltProfile";
import { buildBubblewrapLaunch } from "../process/linuxConfinement";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const data = await mkdtemp(join(tmpdir(), "octant-google-global-guard-"));
  directories.push(data);
  const root = join(data, "harness", "cloud-cli");
  const resource = join(root, "google-running-command");
  const token = join(resource, "access-token");
  const temporary = join(data, "work");
  await mkdir(resource, { recursive: true });
  await mkdir(temporary);
  await writeFile(token, "fixture-running-google-token");
  await symlink(token, join(data, "token-link"));
  configureSecretGuardLocations({ dataDirectory: data });
  return { data, root, resource, token, temporary };
}
describe("Google command tokens use the host-wide credential guard", () => {
  it("refuses actual file-tool reads, edits and searches even through a selected data ancestor or link", async () => {
    const p = await fixture();
    const files = new NativeHarnessFileSystem({ root: p.data });
    for (const path of [p.token, join(p.data, "token-link")]) {
      expect(await files.read({ path })).toMatchObject({
        kind: "refused",
        reason: "protected-file",
      });
      expect(secretGuardRefusal(path, { ownAccountPaths: [p.data] })).toContain(
        "Octant credentials",
      );
    }
    expect(await files.write({ path: p.token, content: "replacement" })).toMatchObject({
      kind: "refused",
      reason: "protected-file",
    });
    const search = await files.grep({ pattern: "fixture-running-google-token" });
    expect(search).toMatchObject({ kind: "matches", matches: [] });
    expect(await readFile(p.token, "utf8")).toBe("fixture-running-google-token");
  });
  it.each(["darwin", "linux"] as const)(
    "protects an existing running token from a non-harness %s launch bound to its data ancestor",
    async (platform) => {
      const p = await fixture();
      const input = {
        executable: "/bin/sh",
        args: ["-c", "true"],
        boundRoot: p.data,
        temporaryDirectory: p.temporary,
        readRoots: [p.data],
        allowFileReadStar: true,
        networkEgress: "none" as const,
      };
      if (platform === "darwin") {
        const profile = buildDenyDefaultSeatbeltProfile({
          ...input,
          homeDirectory: p.data,
          usersDirectory: p.data,
        });
        const denial = profile.lastIndexOf(`(deny file-read* file-write* (subpath "${p.root}"))`);
        expect(denial).toBeGreaterThan(profile.indexOf(seatbeltAllowRule("file-read*", p.data)));
        expect(denial).toBeGreaterThan(profile.indexOf(seatbeltAllowRule("file-write*", p.data)));
      } else {
        const { args } = buildBubblewrapLaunch(input, { bwrapPath: "/bin/true" });
        expect(args.join("\n")).toContain(`--tmpfs\n${p.root}`);
        expect(args.join("\n")).not.toContain(`--ro-bind\n${p.resource}\n${p.resource}`);
      }
      expect(await readFile(p.token, "utf8")).toBe("fixture-running-google-token");
    },
  );
});
