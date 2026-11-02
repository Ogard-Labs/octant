import { describe, expect, it } from "vitest";
import { parseClaudeMcpText, readSection } from "./providerToolingListing";

describe("reading what a provider lists", () => {
  it("reads Claude's server lines after its health-check line", () => {
    expect(
      parseClaudeMcpText(
        "Checking MCP server health…\n\nfiles: node a - ✓ Connected\nhosted: https://example.com/mcp (HTTP) - ✘ Failed\n",
      ),
    ).toEqual([
      { name: "files", detail: "node a - ✓ Connected" },
      { name: "hosted", detail: "https://example.com/mcp (HTTP) - ✘ Failed" },
    ]);
    expect(
      parseClaudeMcpText("No MCP servers configured. Use `claude mcp add` to add a server."),
    ).toEqual([]);
  });

  it("reads each JSON list by the fields it knows and ignores the rest", () => {
    const claudePlugins = readSection({
      provider: "claude",
      kind: "plugins",
      exitCode: 0,
      timedOut: false,
      output: JSON.stringify([
        { id: "hello@market", version: "1.0.0", scope: "user", enabled: true, installPath: "/x" },
        { nonsense: true },
        "text",
      ]),
    });
    expect(claudePlugins.entries).toEqual([
      {
        name: "hello",
        marketplace: "market",
        detail: "Version 1.0.0",
        scope: "user",
        enabled: true,
      },
    ]);
    const codexPlugins = readSection({
      provider: "codex",
      kind: "plugins",
      exitCode: 0,
      timedOut: false,
      output: JSON.stringify({
        installed: [{ name: "hello", marketplaceName: "market", version: "0.0.1", enabled: false }],
        available: [],
      }),
    });
    expect(codexPlugins.entries).toEqual([
      { name: "hello", marketplace: "market", detail: "Version 0.0.1", enabled: false },
    ]);
    const codexServers = readSection({
      provider: "codex",
      kind: "mcp-servers",
      exitCode: 0,
      timedOut: false,
      output: JSON.stringify([
        {
          name: "files",
          enabled: true,
          transport: { type: "stdio", command: "node", args: ["a", "b"] },
        },
        { name: "hosted", transport: { type: "streamable_http", url: "https://example.com/mcp" } },
      ]),
    });
    expect(codexServers.entries.map((entry) => entry.detail)).toEqual([
      "node a b",
      "https://example.com/mcp",
    ]);
  });

  it("shows output it cannot read as plain lines instead of guessing", () => {
    const section = readSection({
      provider: "codex",
      kind: "marketplaces",
      exitCode: 0,
      timedOut: false,
      output: "something new\nin another shape",
    });
    expect(section).toMatchObject({
      status: "unreadable",
      entries: [],
      lines: ["something new", "in another shape"],
    });
  });

  it("says plainly when the installed tool has no such command, and when a command fails or times out", () => {
    expect(
      readSection({
        provider: "codex",
        kind: "plugins",
        exitCode: 2,
        timedOut: false,
        output: "error: unrecognized subcommand 'plugin'",
      }).status,
    ).toBe("no-command");
    expect(
      readSection({
        provider: "claude",
        kind: "plugins",
        exitCode: 1,
        timedOut: false,
        output: "boom",
      }),
    ).toMatchObject({ status: "failed", lines: ["boom"] });
    expect(
      readSection({
        provider: "claude",
        kind: "plugins",
        exitCode: null,
        timedOut: true,
        output: "",
      }).status,
    ).toBe("failed");
  });

  it("strips control characters and bounds what a hostile program prints", () => {
    const section = readSection({
      provider: "codex",
      kind: "mcp-servers",
      exitCode: 0,
      timedOut: false,
      output: JSON.stringify(
        Array.from({ length: 500 }, (_, index) => ({
          name: `s${index}\u001b[31m\n`,
          transport: { url: `https://example.com/${"a".repeat(1000)}` },
        })),
      ),
    });
    expect(section.entries).toHaveLength(200);
    expect(section.entries[0]?.name).toBe("s0 [31m");
    expect(section.entries[0]?.detail?.length).toBeLessThanOrEqual(301);
  });
});
