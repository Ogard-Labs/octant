import { afterEach, expect, it } from "vitest";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_PROTECTED_FILES_CHANGES } from "@octant/domain/secret-guard-policy";
import { applyProtectedFilesChoice, secretGuardMediationPolicy } from "./secretGuard";
import { linuxMediationObjectKey, readLinuxMediationPolicy } from "./linuxMediationPolicy";

import { classifyLinuxMediationMutation } from "./linuxMediationNamespace";

const owned: string[] = [];
afterEach(async () => {
  applyProtectedFilesChoice(NO_PROTECTED_FILES_CHANGES);
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "octant-mediation-policy-")));
  owned.push(directory);
  const home = join(directory, "home");
  await mkdir(join(home, ".ssh"), { recursive: true });
  const readNamespace = async () => ({ epoch: 1n, activeMutations: 0 });
  const policy = (ownAccountPaths: ReadonlyArray<string> = []) =>
    secretGuardMediationPolicy({ platform: "linux", homeDirectory: home, ownAccountPaths });
  const key = async (path: string) => linuxMediationObjectKey(await stat(path, { bigint: true }));
  return { directory, home, readNamespace, policy, key };
}

it("classifies a late companion and its existing hardlink by the actual inode without hiding allowed live files", async () => {
  const f = await fixture();
  const candidate = join(f.home, ".ssh", "deployment");
  const alias = join(f.home, "alias");
  await writeFile(candidate, "synthetic bytes");
  await link(candidate, alias);
  const policy = f.policy();
  const before = await readLinuxMediationPolicy(policy, f.readNamespace);
  expect(before.status).toBe("ready");
  if (before.status !== "ready") throw Error("Missing initial policy snapshot");
  expect(before.protectedObjects.has(await f.key(alias))).toBe(false);
  await writeFile(`${candidate}.pub`, "public companion");
  await mkdir(join(f.home, ".aws"));
  const exact = join(f.home, ".aws", "credentials");
  const named = join(f.home, ".ssh", "id_late");
  await writeFile(exact, "synthetic exact bytes");
  await writeFile(named, "synthetic named bytes");
  const after = await readLinuxMediationPolicy(policy, async () => ({
    epoch: 2n,
    activeMutations: 0,
  }));
  if (after.status !== "ready") throw Error("Missing current policy snapshot");
  expect(after.protectedObjects.has(await f.key(alias))).toBe(true);
  expect(after.protectedObjects.has(await f.key(exact))).toBe(true);
  expect(after.protectedObjects.has(await f.key(named))).toBe(true);
  expect(after.protectedObjects.has(await f.key(`${candidate}.pub`))).toBe(false);
  await writeFile(join(f.home, ".ssh", "config"), "Host example");
  expect(await readFile(join(f.home, ".ssh", "config"), "utf8")).toBe("Host example");
  expect(await f.key(alias)).toBe(await f.key(candidate));
});

it("retains exact original name rules, symlink target identity, account exceptions and added paths", async () => {
  const f = await fixture();
  const secret = join(f.home, ".ssh", "id_synthetic");
  const target = join(f.home, "ordinary-target");
  await writeFile(target, "synthetic bytes");
  await symlink(target, secret);
  const dangling = join(f.home, ".ssh", "id_dangling");
  await symlink("synthetic protected link text", dangling);
  const publicTarget = join(f.home, "public-target");
  const publicLink = join(f.home, ".ssh", "public.pub");
  await writeFile(publicTarget, "synthetic public bytes");
  await symlink(publicTarget, publicLink);
  const secretLinkIdentity = linuxMediationObjectKey(await lstat(secret, { bigint: true }));
  const danglingIdentity = linuxMediationObjectKey(await lstat(dangling, { bigint: true }));
  const publicLinkIdentity = linuxMediationObjectKey(await lstat(publicLink, { bigint: true }));
  const companionFolder = join(f.home, ".ssh", "deployment");
  await mkdir(companionFolder);
  await writeFile(`${companionFolder}.pub`, "public companion");
  const nested = join(companionFolder, "nested.txt");
  await writeFile(nested, "synthetic nested bytes");
  const own = join(f.home, ".claude");
  await mkdir(own);
  const account = join(own, ".credentials.json");
  await writeFile(account, "synthetic sign-in");
  const custom = join(f.home, "nøkkel");
  await writeFile(custom, "synthetic custom bytes");
  const snapshot = await readLinuxMediationPolicy(
    f.policy([own, join(f.home, ".ssh")]),
    f.readNamespace,
  );
  if (snapshot.status !== "ready") throw Error("Missing policy snapshot");
  expect(snapshot.protectedObjects.has(await f.key(target))).toBe(true);
  expect(snapshot.protectedObjects.has(secretLinkIdentity)).toBe(true);
  expect(snapshot.protectedObjects.has(danglingIdentity)).toBe(true);
  expect(snapshot.protectedObjects.has(publicLinkIdentity)).toBe(false);
  expect(snapshot.protectedObjects.has(await f.key(publicTarget))).toBe(false);
  expect(snapshot.protectedObjects.has(await f.key(nested))).toBe(true);
  expect(snapshot.protectedObjects.has(await f.key(account))).toBe(false);
  applyProtectedFilesChoice({ added: [account, custom], removed: ["ssh-private-keys"] });
  const changed = await readLinuxMediationPolicy(f.policy([own]), f.readNamespace);
  if (changed.status !== "ready") throw Error("Missing changed policy snapshot");
  expect(changed.protectedObjects.has(await f.key(target))).toBe(false);
  expect(changed.protectedObjects.has(secretLinkIdentity)).toBe(false);
  expect(changed.protectedObjects.has(danglingIdentity)).toBe(false);
  expect(changed.protectedObjects.has(await f.key(nested))).toBe(false);
  expect(changed.protectedObjects.has(await f.key(account))).toBe(true);
  expect(changed.protectedObjects.has(await f.key(custom))).toBe(true);
});

it.skipIf(process.platform !== "linux")(
  "keeps protected Linux names byte-exact instead of losing invalid UTF-8 aliases",
  async () => {
    const f = await fixture();
    const path = Buffer.concat([Buffer.from(join(f.home, ".ssh", "id_")), Buffer.from([0xff])]);
    const alias = join(f.home, "alias");
    await writeFile(path, "synthetic invalid-name bytes");
    await link(path, alias);
    const snapshot = await readLinuxMediationPolicy(f.policy(), f.readNamespace);
    if (snapshot.status !== "ready") throw Error("Missing byte-exact policy snapshot");
    expect(snapshot.protectedObjects.has(await f.key(alias))).toBe(true);
  },
);

it("never treats a scan concurrent with an outside namespace mutation as a valid admission snapshot", async () => {
  const f = await fixture();
  let reads = 0;
  const changed = await readLinuxMediationPolicy(f.policy(), async () => ({
    epoch: ++reads === 1 ? 1n : 2n,
    activeMutations: 0,
  }));
  expect(changed).toEqual({ status: "unavailable", reason: "namespace-changed" });
  expect(
    await readLinuxMediationPolicy(f.policy(), async () => ({ epoch: 2n, activeMutations: 1 })),
  ).toEqual({
    status: "unavailable",
    reason: "namespace-changing",
  });
});

it("does not transfer an enrolled account exception when its path is replaced by a link to another sign-in", async () => {
  const f = await fixture();
  const own = join(f.home, ".claude");
  const foreign = join(f.home, ".codex");
  await mkdir(own);
  await mkdir(foreign);
  const credentials = join(foreign, "auth.json");
  await writeFile(credentials, "synthetic foreign sign-in");
  const policy = f.policy([own]);
  await rename(own, `${own}-previous`);
  await symlink(foreign, own);
  const snapshot = await readLinuxMediationPolicy(policy, f.readNamespace);
  if (snapshot.status !== "ready") throw Error("Missing current policy snapshot");
  expect(snapshot.protectedObjects.has(await f.key(credentials))).toBe(true);
});

it("refuses only destructive companion or ancestor changes that would declassify existing protected content", async () => {
  const f = await fixture();
  const ssh = join(f.home, ".ssh");
  const custom = join(ssh, "deployment");
  await writeFile(custom, "synthetic private bytes");
  await writeFile(`${custom}.pub`, "public bytes");
  const classify = (name: string, destination?: string) =>
    classifyLinuxMediationMutation(
      f.policy(),
      {
        operation: destination === undefined ? "unlink" : "rename",
        source: { parent: ssh, name: Buffer.from(name) },
        ...(destination === undefined
          ? {}
          : { destination: { parent: ssh, name: Buffer.from(destination) } }),
        flags: 0,
      },
      f.readNamespace,
    );
  expect((await classify("deployment.pub")).status).toBe("refused");
  expect((await classify("deployment.pub", "retired.pub")).status).toBe("refused");
  expect(
    (
      await classifyLinuxMediationMutation(
        f.policy(),
        {
          operation: "rename",
          source: { parent: f.home, name: Buffer.from(".ssh") },
          destination: { parent: f.home, name: Buffer.from("moved") },
          flags: 0,
        },
        f.readNamespace,
      )
    ).status,
  ).toBe("refused");
  await link(`${custom}.pub`, join(f.home, "unrelated.pub"));
  expect(
    (
      await classifyLinuxMediationMutation(
        f.policy(),
        {
          operation: "unlink",
          source: { parent: f.home, name: Buffer.from("unrelated.pub") },
          flags: 0,
        },
        f.readNamespace,
      )
    ).status,
  ).toBe("allowed");
  await writeFile(join(ssh, "id_independent"), "independently protected");
  await writeFile(join(ssh, "id_independent.pub"), "public bytes");
  expect((await classify("id_independent.pub")).status).toBe("allowed");
  await mkdir(join(ssh, "ordinary"));
  await writeFile(join(ssh, "ordinary", "note"), "permitted bytes");
  expect((await classify("ordinary", "renamed")).status).toBe("allowed");
  expect(await readFile(`${custom}.pub`, "utf8")).toBe("public bytes");
  expect(await readFile(join(ssh, "ordinary", "note"), "utf8")).toBe("permitted bytes");
});

it("keeps symlink protection across permitted renames and refuses moving away its actual target ancestor", async () => {
  const f = await fixture();
  const target = join(f.directory, "outside");
  await mkdir(target);
  await writeFile(join(target, "key"), "synthetic linked bytes");
  const ssh = join(f.home, ".ssh");
  await symlink(join(target, "key"), join(ssh, "id_link"));
  expect(
    (
      await classifyLinuxMediationMutation(
        f.policy(),
        {
          operation: "rename",
          source: { parent: ssh, name: Buffer.from("id_link") },
          destination: { parent: ssh, name: Buffer.from("id_renamed") },
          flags: 0,
        },
        f.readNamespace,
      )
    ).status,
  ).toBe("allowed");
  expect(
    (
      await classifyLinuxMediationMutation(
        f.policy(),
        {
          operation: "rename",
          source: { parent: f.directory, name: Buffer.from("outside") },
          destination: { parent: f.directory, name: Buffer.from("moved") },
          flags: 0,
        },
        f.readNamespace,
      )
    ).status,
  ).toBe("refused");
});

it("allows exchanging a public companion while its protecting name remains and never treats a changing epoch as approval", async () => {
  const f = await fixture();
  const ssh = join(f.home, ".ssh");
  await writeFile(join(ssh, "deployment"), "synthetic private bytes");
  await writeFile(join(ssh, "deployment.pub"), "public bytes");
  await writeFile(join(f.home, "ordinary"), "ordinary bytes");
  const mutation = {
    operation: "rename" as const,
    source: { parent: ssh, name: Buffer.from("deployment.pub") },
    destination: { parent: f.home, name: Buffer.from("ordinary") },
    flags: 2,
  };
  expect((await classifyLinuxMediationMutation(f.policy(), mutation, f.readNamespace)).status).toBe(
    "allowed",
  );
  let reads = 0;
  expect(
    (
      await classifyLinuxMediationMutation(f.policy(), mutation, async () => ({
        epoch: ++reads < 3 ? 1n : 2n,
        activeMutations: 0,
      }))
    ).status,
  ).toBe("unavailable");
});
