import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInstance } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
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
