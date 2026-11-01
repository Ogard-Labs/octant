import { describe, expect, it } from "vitest";
import { openCodeOwnRulesAllow, projectOpenCodeOwnSetup } from "./openCodeOwnSetup";

const environment = new Set(["GITHUB_TOKEN", "HOME"]);

describe("projectOpenCodeOwnSetup", () => {
  it("reads the person's permission rules in the order they wrote them", () => {
    const setup = projectOpenCodeOwnSetup(
      { permission: { bash: { "git status": "allow", "*": "ask" }, edit: "allow", read: "deny" } },
      environment,
    );
    expect(setup.rules).toEqual([
      { action: "bash", resource: "git status", effect: "allow" },
      { action: "shell", resource: "git status", effect: "allow" },
      { action: "bash", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "read", resource: "*", effect: "deny" },
    ]);
  });

  it("ignores a catch-all rule spelled with more stars", () => {
    expect(
      projectOpenCodeOwnSetup(
        { permission: { "**": "allow", "*": { "**": "allow" } } },
        environment,
      ).rules,
    ).toEqual([]);
  });

  it("drops a server whose command line carries a credential", () => {
    const setup = projectOpenCodeOwnSetup(
      { mcp: { x: { type: "local", command: ["srv", "--api-key=sk-123"] } } },
      environment,
    );
    expect(setup.mcp).toEqual({});
  });

  it("ignores a catch-all rule, which only the guardrail level may set", () => {
    expect(projectOpenCodeOwnSetup({ permission: { "*": "allow" } }, environment).rules).toEqual(
      [],
    );
  });

  it("leaves the rules Octant owns to Octant", () => {
    const setup = projectOpenCodeOwnSetup(
      {
        permission: {
          external_directory: "allow",
          question: "allow",
          skill: "allow",
          "*_*": "allow",
          webfetch: "allow",
        },
      },
      environment,
    );
    expect(setup.rules).toEqual([{ action: "webfetch", resource: "*", effect: "allow" }]);
  });

  it("keeps a local MCP server but never a literal credential", () => {
    const setup = projectOpenCodeOwnSetup(
      {
        mcp: {
          docs: {
            type: "local",
            command: ["npx", "docs-server"],
            environment: {
              API_TOKEN: "sk-literal-secret",
              GH_PAT: "ghp_secret",
              MODE: "fast",
              HOME_DIR: "{env:HOME}",
            },
          },
        },
      },
      environment,
    );
    expect(setup.mcp).toEqual({
      docs: {
        type: "local",
        command: ["npx", "docs-server"],
        environment: { HOME_DIR: "{env:HOME}" },
      },
    });
  });

  it("keeps a remote server's header only as a reference to a variable the host has", () => {
    const setup = projectOpenCodeOwnSetup(
      {
        mcp: {
          issues: {
            type: "remote",
            url: "https://mcp.example.com/sse",
            headers: {
              Authorization: "Bearer {env:GITHUB_TOKEN}",
              "X-Other": "Bearer {env:MISSING_VARIABLE}",
              "X-Literal": "secret",
            },
          },
        },
      },
      environment,
    );
    expect(setup.mcp).toEqual({
      issues: {
        type: "remote",
        url: "https://mcp.example.com/sse",
        headers: { Authorization: "Bearer {env:GITHUB_TOKEN}" },
      },
    });
  });

  it("drops a server whose URL carries credentials or whose type is unknown", () => {
    const setup = projectOpenCodeOwnSetup(
      {
        mcp: {
          a: { type: "remote", url: "https://user:pass@example.com/" },
          b: { type: "remote", url: "https://example.com/?api_key=1" },
          c: { type: "weird" },
          "bad name!": { type: "local", command: ["x"] },
        },
      },
      environment,
    );
    expect(setup.mcp).toEqual({});
  });
});

describe("openCodeOwnRulesAllow", () => {
  const rules = projectOpenCodeOwnSetup(
    { permission: { edit: { "*": "ask", "docs/*": "allow" } } },
    environment,
  ).rules;

  it("allows an edit only where the last matching rule allows it", () => {
    expect(openCodeOwnRulesAllow(rules, "edit", ["docs/readme.md"])).toBe(true);
    expect(openCodeOwnRulesAllow(rules, "edit", ["src/index.ts"])).toBe(false);
  });

  it("allows nothing for an action no rule names", () => {
    expect(openCodeOwnRulesAllow(rules, "bash", ["docs/readme.md"])).toBe(false);
  });
});
