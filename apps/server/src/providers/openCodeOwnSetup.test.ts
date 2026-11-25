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

  it("ignores a catch-all allow or ask, which only the guardrail level may set", () => {
    for (const effect of ["allow", "ask"] as const) {
      const setup = projectOpenCodeOwnSetup({ permission: { "*": effect } }, environment);
      expect(setup.rules).toEqual([]);
      expect(setup.outsideFolderRules).toBeUndefined();
    }
  });

  it("keeps a catch-all deny where the person wrote it, so the rules after it still open what they open in OpenCode", () => {
    const setup = projectOpenCodeOwnSetup(
      { permission: { "*": "deny", read: "allow", bash: { "git status": "allow" } } },
      environment,
    );
    expect(setup.rules).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "bash", resource: "git status", effect: "allow" },
      { action: "shell", resource: "git status", effect: "allow" },
    ]);
    // Skills follow their own switch, so the refusal is restated for them.
    expect(setup.skillRules).toEqual([{ action: "skill", resource: "*", effect: "deny" }]);
    // A catch-all covers folders outside the Project too.
    expect(setup.outsideFolderRules).toEqual([
      { action: "external_directory", resource: "*", effect: "deny" },
    ]);
  });

  it("keeps the person's own refusal of a folder outside the Project, with the allows that carve out of it", () => {
    const setup = projectOpenCodeOwnSetup(
      {
        permissions: [
          { action: "external_directory", resource: "*", effect: "deny" },
          { action: "external_directory", resource: "/work/shared/*", effect: "allow" },
          { action: "*_*", resource: "*", effect: "deny" },
        ],
      },
      environment,
    );
    // An outside-folder rule never joins the person's ordinary rules: the
    // level owns what such a folder is allowed or asked.
    expect(setup.rules).toEqual([{ action: "*_*", resource: "*", effect: "deny" }]);
    expect(setup.outsideFolderRules).toEqual([
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "/work/shared/*", effect: "allow" },
      // `*_*` covers `external_directory` as well.
      { action: "external_directory", resource: "*", effect: "deny" },
    ]);
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

  it("keeps the person's rules for their own skills apart, for a session whose skills are on", () => {
    const setup = projectOpenCodeOwnSetup(
      { permission: { skill: { "*": "allow", "release-*": "deny" }, edit: "ask" } },
      environment,
    );
    expect(setup.rules).toEqual([{ action: "edit", resource: "*", effect: "ask" }]);
    expect(setup.skillRules).toEqual([
      { action: "skill", resource: "*", effect: "allow" },
      { action: "skill", resource: "release-*", effect: "deny" },
    ]);
  });

  it("reads the person's MCP servers as OpenCode 1 and as OpenCode 2 write them", () => {
    const setup = projectOpenCodeOwnSetup(
      {
        mcp: {
          timeout: { startup: 5_000 },
          older: { type: "local", command: ["older-server"], enabled: false },
          both: { type: "local", command: ["first"] },
          servers: {
            newer: { type: "remote", url: "https://mcp.example.com/sse", disabled: true },
            running: { type: "local", command: ["running-server"], disabled: false },
            both: { type: "local", command: ["second"] },
          },
        },
      },
      environment,
    );
    expect(setup.mcp).toEqual({
      older: { type: "local", command: ["older-server"], enabled: false },
      both: { type: "local", command: ["second"] },
      newer: { type: "remote", url: "https://mcp.example.com/sse", enabled: false },
      running: { type: "local", command: ["running-server"], enabled: true },
    });
  });

  it("says when the person's own policies allow a tool server, which outranks Octant's inline policy", () => {
    const allows = (config: unknown) =>
      projectOpenCodeOwnSetup(config, environment).allowsToolServerByPolicy;
    expect(allows({ policies: [{ action: "mcp.use", resource: "docs", effect: "allow" }] })).toBe(
      true,
    );
    expect(
      allows({ policies: [{ action: "integration.use", resource: "mcp:docs", effect: "allow" }] }),
    ).toBe(true);
    expect(
      allows({
        experimental: { policies: [{ action: "mcp.use", resource: "*", effect: "allow" }] },
      }),
    ).toBe(true);
    expect(
      allows({
        policies: [
          { action: "mcp.use", resource: "docs", effect: "deny" },
          { action: "provider.use", resource: "*", effect: "allow" },
        ],
      }),
    ).toBeUndefined();
  });

  it("reads a server the person named `servers` in the older shape as that server", () => {
    const setup = projectOpenCodeOwnSetup(
      { mcp: { servers: { type: "local", command: ["a-server-called-servers"] } } },
      environment,
    );
    expect(setup.mcp).toEqual({
      servers: { type: "local", command: ["a-server-called-servers"] },
    });
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
