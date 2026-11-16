import { describe, expect, it } from "vitest";
import { projectCodeEntries, projectCodeTrust } from "./projectCodeTrustPolicy";

describe("a Project's own code and its trust", () => {
  it("asks to trust a Work or Code Project that holds Claude Code settings and MCP servers", () => {
    for (const projectType of ["work", "code"] as const) {
      expect(
        projectCodeTrust({
          driverKind: "claude",
          projectType,
          trusted: false,
          present: [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"],
        }),
      ).toEqual({ status: "untrusted", provider: "claude", found: ["settings", "mcp-servers"] });
    }
  });

  it("asks to trust a Project that holds its own OpenCode configuration", () => {
    expect(
      projectCodeTrust({
        driverKind: "opencode",
        projectType: "work",
        trusted: false,
        present: [".opencode/opencode.json"],
      }),
    ).toEqual({ status: "untrusted", provider: "opencode", found: ["settings"] });
  });

  it("asks to trust a Project that holds an ACP agent's own settings, extensions, and skills", () => {
    expect(
      projectCodeTrust({
        driverKind: "gemini",
        projectType: "code",
        trusted: false,
        present: [".gemini/settings.json", ".gemini/extensions", ".agents/skills"],
      }),
    ).toEqual({
      status: "untrusted",
      provider: "gemini",
      found: ["settings", "plugins", "skills"],
    });
  });

  it("reports a Project already trusted for the provider without asking", () => {
    expect(
      projectCodeTrust({
        driverKind: "mistral-vibe",
        projectType: "code",
        trusted: true,
        present: [".vibe/config.toml", ".vibe/tools"],
      }),
    ).toEqual({ status: "trusted", provider: "mistral-vibe", found: ["settings", "tools"] });
  });

  it("asks nothing of a Project folder that holds none of the provider's Project code", () => {
    expect(
      projectCodeTrust({
        driverKind: "claude",
        projectType: "code",
        trusted: false,
        present: [".vibe/config.toml"],
      }),
    ).toEqual({ status: "none" });
  });

  it("asks nothing for a provider that is not a key provider, or whose trust loads no Project code", () => {
    for (const driverKind of ["pi", "codex"] as const) {
      expect(
        projectCodeTrust({
          driverKind,
          projectType: "code",
          trusted: false,
          present: [".claude/settings.json", ".mcp.json", ".codex/config.toml"],
        }),
      ).toEqual({ status: "none" });
    }
    expect(projectCodeEntries("pi")).toEqual([]);
  });

  it("asks nothing in a Chat Project, which has no folder", () => {
    expect(
      projectCodeTrust({
        driverKind: "claude",
        projectType: "chat",
        trusted: false,
        present: [".mcp.json"],
      }),
    ).toEqual({ status: "none" });
  });
});
