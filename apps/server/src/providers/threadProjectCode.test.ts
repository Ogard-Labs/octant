import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInstance } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderCliProjectTrust } from "./providerCliProjectTrust";
import { readThreadProjectCode, type ThreadProjectCodeSources } from "./threadProjectCode";

const threadId = "80000000-0000-4000-8000-000000000070";
const projectId = "80000000-0000-4000-8000-000000000071";
const instanceId = "80000000-0000-4000-8000-000000000072";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectRoot(entries: Readonly<Record<string, string | "dir">>): string {
  const root = mkdtempSync(join(tmpdir(), "octant-project-code-"));
  roots.push(root);
  for (const [path, content] of Object.entries(entries)) {
    const target = join(root, path);
    if (content === "dir") {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
  }
  return root;
}

function sources(input: {
  readonly root: string;
  readonly driverKind: ProviderInstance["driverKind"];
  readonly nativeProviders?: ReadonlyArray<string>;
  readonly readProviderCliTrust?: ThreadProjectCodeSources["readProviderCliTrust"];
  readonly strict?: boolean;
}): ThreadProjectCodeSources {
  const thread = { id: threadId, projectId, providerInstanceId: instanceId };
  return {
    readWorkThread: () => thread as never,
    readCodeThread: () => thread as never,
    readProject: () =>
      ({
        id: projectId,
        type: "code",
        binding: { canonicalRoot: input.root },
        ...(input.nativeProviders === undefined ? {} : { nativeProviders: input.nativeProviders }),
      }) as never,
    readProviderInstance: () => ({ id: instanceId, driverKind: input.driverKind }) as never,
    ...(input.readProviderCliTrust === undefined
      ? {}
      : { readProviderCliTrust: input.readProviderCliTrust }),
    readStrict: () => input.strict ?? false,
  };
}

describe("reading a thread's untrusted Project code", () => {
  it("reports Claude Code settings, MCP servers, and skills in an untrusted Project", async () => {
    const root = projectRoot({
      ".claude/settings.json": "{}",
      ".mcp.json": "{}",
      ".claude/skills": "dir",
    });
    await expect(
      readThreadProjectCode(sources({ root, driverKind: "claude" }), { threadId, mode: "code" }),
    ).resolves.toEqual({
      status: "untrusted",
      provider: "claude",
      found: ["settings", "mcp-servers", "skills"],
    });
  });

  it("reports a Project's own OpenCode configuration as untrusted until the Project trusts OpenCode", async () => {
    const root = projectRoot({ "opencode.jsonc": "{}", ".opencode/opencode.json": "{}" });
    await expect(
      readThreadProjectCode(sources({ root, driverKind: "opencode" }), { threadId, mode: "code" }),
    ).resolves.toEqual({ status: "untrusted", provider: "opencode", found: ["settings"] });
  });

  it("reports a Mistral Vibe Project's entries as trusted once the Project trusts Vibe", async () => {
    const root = projectRoot({ ".vibe/config.toml": "", ".vibe/hooks.toml": "" });
    await expect(
      readThreadProjectCode(
        sources({ root, driverKind: "mistral-vibe", nativeProviders: ["mistral-vibe"] }),
        { threadId, mode: "work" },
      ),
    ).resolves.toEqual({
      status: "trusted",
      provider: "mistral-vibe",
      found: ["settings", "hooks"],
    });
  });

  it("counts a Project trusted in the provider's own CLI as trusted, and asks where the CLI has no record", async () => {
    const parent = projectRoot({ "app/.claude/settings.json": "{}" });
    const root = join(parent, "app");
    const home = projectRoot({
      ".claude.json": JSON.stringify({
        projects: { [parent]: { hasTrustDialogAccepted: true } },
      }),
      ".codex/config.toml": "",
    });
    const codexConfig = { projects: { [root]: { trust_level: "trusted" } } };
    const trust = createProviderCliProjectTrust({
      home,
      environment: {},
      parseToml: () => codexConfig,
    });
    // Claude Code's trust of a folder above the Project covers it.
    await expect(
      readThreadProjectCode(sources({ root, driverKind: "claude", readProviderCliTrust: trust }), {
        threadId,
        mode: "code",
      }),
    ).resolves.toMatchObject({ status: "trusted", provider: "claude" });
    expect(trust("codex", root)).toBe(true);
    expect(trust("codex", join(root, "nested"))).toBe(false);
    // A folder no CLI trusted keeps Octant's card.
    const elsewhere = mkdtempSync(join(tmpdir(), "octant-untrusted-"));
    roots.push(elsewhere);
    writeFileSync(join(elsewhere, ".mcp.json"), "{}");
    await expect(
      readThreadProjectCode(
        sources({ root: elsewhere, driverKind: "claude", readProviderCliTrust: trust }),
        { threadId, mode: "code" },
      ),
    ).resolves.toMatchObject({ status: "untrusted" });
  });

  it("asks again under Strict for a Project only the provider's own CLI trusts, and keeps Octant's own trust", async () => {
    const root = projectRoot({ ".mcp.json": "{}" });
    const trust: ThreadProjectCodeSources["readProviderCliTrust"] = () => true;
    await expect(
      readThreadProjectCode(
        sources({ root, driverKind: "claude", readProviderCliTrust: trust, strict: true }),
        { threadId, mode: "code" },
      ),
    ).resolves.toMatchObject({ status: "untrusted", provider: "claude" });
    await expect(
      readThreadProjectCode(
        sources({ root, driverKind: "claude", readProviderCliTrust: trust, strict: false }),
        { threadId, mode: "code" },
      ),
    ).resolves.toMatchObject({ status: "trusted", provider: "claude" });
    await expect(
      readThreadProjectCode(
        sources({ root, driverKind: "claude", nativeProviders: ["claude"], strict: true }),
        { threadId, mode: "code" },
      ),
    ).resolves.toMatchObject({ status: "trusted", provider: "claude" });
  });

  it("reports nothing for a Project folder without the provider's Project code", async () => {
    const root = projectRoot({ "README.md": "", ".vibe/config.toml": "" });
    await expect(
      readThreadProjectCode(sources({ root, driverKind: "claude" }), { threadId, mode: "code" }),
    ).resolves.toEqual({ status: "none" });
  });

  it("reports nothing for a provider that is not a key provider, or whose trust loads no Project code", async () => {
    const root = projectRoot({ ".claude/settings.json": "{}", ".mcp.json": "{}" });
    for (const driverKind of ["pi", "codex"] as const) {
      await expect(
        readThreadProjectCode(sources({ root, driverKind }), { threadId, mode: "code" }),
      ).resolves.toEqual({ status: "none" });
    }
  });

  it("reports nothing for a thread the host does not know", async () => {
    const root = projectRoot({ ".mcp.json": "{}" });
    await expect(
      readThreadProjectCode(
        { ...sources({ root, driverKind: "claude" }), readCodeThread: () => undefined },
        { threadId, mode: "code" },
      ),
    ).resolves.toEqual({ status: "none" });
  });
});
