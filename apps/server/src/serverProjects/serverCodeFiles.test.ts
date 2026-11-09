import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { Schema } from "effect";
import { ServerProject } from "@octant/contracts/server-projects";
import { decodeWindowId, decodeWorkThreadId } from "@octant/contracts";
import { createServerWorkFileListing } from "./serverWorkFiles";
import { serverWorkBindingRevisionId } from "./serverWorkThreads";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  decodeCodeCheckoutId,
  decodeCodeRelativePath,
  decodeCodeThreadId,
} from "@octant/contracts/code";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeContentStore } from "../code/codeContentStore";
import { ServerCodeFiles } from "./serverCodeFiles";
import { ServerConnection } from "./serverConnection";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

const threadId = decodeCodeThreadId("1a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d");
const checkoutId = decodeCodeCheckoutId("6a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d");
const path = (value: string) => decodeCodeRelativePath(value);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!canRunThrowawaySshd)("a server Project's file browser", () => {
  let sshd: ThrowawaySshd;
  let connection: ServerConnection;
  let root = "";
  let controlDirectory = "";
  const content = new CodeContentStore();

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    controlDirectory = realpathSync(mkdtempSync("/tmp/octant-work-files-control-"));
    connection = new ServerConnection({
      agentSocket: () => sshd.agentSocket,
      configFile: sshd.configFile,
      controlDirectory: () => controlDirectory,
    });
    root = join(sshd.root, "service");
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, "README.md"), "# Service\n");
    writeFileSync(join(root, "src", "main.ts"), "export const answer = 42;\n");
    writeFileSync(join(root, "src", "deep", "leaf.txt"), "leaf\n");
    writeFileSync(join(root, "logo.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "x\n");
    writeFileSync(join(root, ".ssh", "id_ed25519"), "secret\n");
    writeFileSync(join(root, "deploy.pem"), "secret\n");
    writeFileSync(join(sshd.root, "outside.txt"), "outside\n");
    symlinkSync(join(sshd.root, "outside.txt"), join(root, "escape.txt"));
  }, 30_000);

  afterAll(async () => {
    if (sshd === undefined) return;
    const processes = () =>
      execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="], { encoding: "utf8" })
        .split("\n")
        .flatMap((line) => {
          const found = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
          return found === null
            ? []
            : [
                {
                  pid: Number(found[1]),
                  parent: Number(found[2]),
                  identity: found[3] + " " + found[4],
                  command: found[4] ?? "",
                },
              ];
        });
    const before = processes();
    const owned = new Set(
      before
        .filter(
          (p) =>
            p.command.includes(sshd.root) ||
            p.command.includes(sshd.agentSocket) ||
            (controlDirectory !== "" && p.command.includes(controlDirectory)),
        )
        .map((p) => p.pid),
    );
    for (let pass = 0; pass < before.length; pass++) {
      const children = before.filter((p) => owned.has(p.parent) && !owned.has(p.pid));
      if (children.length === 0) break;
      children.forEach((p) => owned.add(p.pid));
    }
    const identities = before.filter((p) => owned.has(p.pid));
    const control = controlDirectory;
    if (existsSync(control))
      for (const name of readdirSync(control)) {
        spawnSync(
          "/usr/bin/ssh",
          ["-F", sshd.configFile, "-S", join(control, name), "-O", "exit", "--", sshd.alias],
          { stdio: "ignore", timeout: 2000 },
        );
      }
    sshd.stop();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const remaining = processes();
      if (
        !identities.some((p) =>
          remaining.some((now) => now.pid === p.pid && now.identity === p.identity),
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      processes().filter((now) =>
        identities.some((p) => p.pid === now.pid && p.identity === now.identity),
      ),
    ).toEqual([]);
    expect(existsSync(sshd.root)).toBe(false);
    expect(existsSync(sshd.agentSocket)).toBe(false);
    rmSync(controlDirectory, { recursive: true, force: true });
    expect(existsSync(controlDirectory)).toBe(false);
  });

  const files = (alias = () => sshd.alias) =>
    new ServerCodeFiles({
      connection,
      server: () => ({ alias: alias(), user: sshd.user }),
      root,
      content,
      clock: () => "2026-11-01T12:00:00.000Z",
    });

  it("lists a Work thread through real SSH without minting previews or falling back locally", async () => {
    const project = Schema.decodeUnknownSync(ServerProject)({
      id: "11111111-1111-4111-8111-111111111112",
      name: "Server notes",
      serverId: "11111111-1111-4111-8111-111111111113",
      folder: root,
      mode: "work",
      boundAt: "2026-11-08T12:00:00.000Z",
    });
    const workThreadId = decodeWorkThreadId("22222222-2222-4222-8222-222222222223");
    let alias = sshd.alias;
    const reader = createServerWorkFileListing({
      store: {
        project: () => project,
        workProject: () => project,
        addressOf: () => ({ kind: "address", server: { alias, user: sshd.user }, folder: root }),
      },
      connection,
      thread: () => ({
        id: workThreadId,
        projectId: project.id,
        lifecycle: "active",
        bindingRevisionId: serverWorkBindingRevisionId(project),
      }),
      canOpen: async () => true,
      clock: () => "2026-11-08T12:00:00.000Z",
    });
    const input = {
      windowId: decodeWindowId("33333333-3333-4333-8333-333333333333"),
      threadId: workThreadId,
      projectId: project.id,
      signal: new AbortController().signal,
      current: () => true,
    };
    const result = await reader.list(input);
    expect(result.status).toBe("listed");
    if (result.status !== "listed") throw Error("Expected server Work files.");
    expect(result.listing.entries.map((entry) => entry.path)).toEqual([
      "logo.bin",
      "README.md",
      "src",
      "src/deep",
      "src/main.ts",
      "src/deep/leaf.txt",
    ]);
    expect(result.listing.entries.find((entry) => entry.path === "README.md")).toEqual({
      kind: "file",
      path: "README.md",
      byteLength: 10,
      origin: "untouched",
    });
    expect(result.listing.previewHostId).toBeUndefined();
    alias = sshd.closedAlias;
    expect((await reader.list(input)).status).toBe("failed");
  });

  it("lists the folder's real files and folders, without Git, dependencies, links, or keys", async () => {
    const listed = await files().list({ threadId, checkoutId });
    expect(listed.status).toBe("listed");
    if (listed.status !== "listed") return;
    expect(listed.listing.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      "file:logo.bin",
      "file:README.md",
      "directory:src",
      "directory:src/deep",
      "file:src/main.ts",
      "file:src/deep/leaf.txt",
    ]);
    expect(listed.listing.entries.find((entry) => entry.path === "README.md")).toMatchObject({
      byteLength: 10,
      availability: { status: "available" },
    });
  });

  it("lists one folder below the root", async () => {
    const listed = await files().list({ threadId, checkoutId, directory: path("src/deep") });
    expect(listed.status === "listed" && listed.listing.entries.map((entry) => entry.path)).toEqual(
      ["src/deep/leaf.txt"],
    );
  });

  it("opens a text file for editing and a binary one read-only", async () => {
    const opened = await files().open({ path: path("src/main.ts") });
    expect(opened).toMatchObject({
      status: "editable",
      metadata: { byteLength: 26, digest: sha("export const answer = 42;\n") },
    });
    if (opened.status === "editable") {
      expect(Buffer.from(content.get(opened.content.contentId)).toString()).toBe(
        "export const answer = 42;\n",
      );
    }
    expect(await files().open({ path: path("logo.bin") })).toMatchObject({
      status: "read-only",
      reason: "binary",
    });
  });

  it("refuses a link out of the folder and a key file before any byte travels", async () => {
    expect(await files().open({ path: path("escape.txt") })).toMatchObject({
      status: "failed",
      failure: { code: "outside-root" },
    });
    expect(await files().open({ path: path("deploy.pem") })).toMatchObject({
      status: "failed",
      failure: { code: "protected" },
    });
  });

  it("saves the editor's text, and refuses a save when the file changed on the server since", async () => {
    const browser = files();
    chmodSync(join(root, "README.md"), 0o751);
    const opened = await browser.open({ path: path("README.md") });
    if (opened.status !== "editable") throw new Error("README.md did not open.");
    const saved = await browser.save({
      path: path("README.md"),
      text: "# Service\nedited here\n",
      expectedIdentity: opened.metadata.identity,
      expectedDigest: opened.metadata.digest,
    });
    expect(saved).toMatchObject({
      status: "completed",
      metadata: { digest: sha("# Service\nedited here\n") },
    });
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# Service\nedited here\n");
    expect(statSync(join(root, "README.md")).mode & 0o777).toBe(0o751);
    writeFileSync(join(root, "README.md"), "changed on the server\n");
    expect(
      await browser.save({
        path: path("README.md"),
        text: "stale\n",
        expectedIdentity: opened.metadata.identity,
        expectedDigest: sha("# Service\nedited here\n"),
      }),
    ).toMatchObject({ status: "conflict" });
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("changed on the server\n");
  });

  it("fails closed when the server cannot be reached", async () => {
    const unreachable = files(() => sshd.closedAlias);
    expect(await unreachable.list({ threadId, checkoutId })).toMatchObject({
      status: "failed",
      failure: { category: "unavailable" },
    });
    expect(await unreachable.open({ path: path("README.md") })).toMatchObject({
      status: "failed",
      failure: { category: "unavailable" },
    });
  });
});
