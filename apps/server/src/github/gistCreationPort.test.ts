import { describe, expect, it } from "vitest";
import type { GhCatalogueCommandPort } from "./ghRepositoryCataloguePort";
import { createGistCreationPort } from "./gistCreationPort";

interface Call {
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

/** A `gh` command port that records the one command it is asked to run. */
function fakeCommand(answer: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
}): { readonly command: GhCatalogueCommandPort; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    command: {
      run: async (arguments_, options) => {
        calls.push({ args: arguments_, stdin: options.stdin });
        return answer;
      },
    },
  };
}

const createdGist = JSON.stringify({
  id: "aa11bb22cc33dd44",
  html_url: "https://gist.github.com/octocat/aa11bb22cc33dd44",
});

describe("creating a gist through gh", () => {
  it("sends one POST to the gist API with the document as the only file", async () => {
    const { command, calls } = fakeCommand({ exitCode: 0, stdout: createdGist });
    const port = createGistCreationPort(command);

    const result = await port.create({
      fileName: "Launch plan.md",
      content: "# Launch plan\n",
      description: "Launch plan",
      visibility: "secret",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "api",
      "gists",
      "--method",
      "POST",
      "--hostname",
      "github.com",
      "--input",
      "-",
    ]);
    expect(JSON.parse(calls[0]?.stdin ?? "")).toEqual({
      description: "Launch plan",
      public: false,
      files: { "Launch plan.md": { content: "# Launch plan\n" } },
    });
    expect(result).toEqual({
      kind: "created",
      gist: { id: "aa11bb22cc33dd44", url: "https://gist.github.com/octocat/aa11bb22cc33dd44" },
    });
  });

  it("marks the gist public when the person chose public", async () => {
    const { command, calls } = fakeCommand({ exitCode: 0, stdout: createdGist });
    const port = createGistCreationPort(command);

    await port.create({
      fileName: "Launch plan.md",
      content: "# Launch plan\n",
      description: "Launch plan",
      visibility: "public",
    });

    expect(JSON.parse(calls[0]?.stdin ?? "").public).toBe(true);
  });

  it("maps a 401 to unauthorized", async () => {
    const { command } = fakeCommand({
      exitCode: 1,
      stdout: "",
      stderr: "HTTP 401: Bad credentials",
    });
    const port = createGistCreationPort(command);

    const result = await port.create({
      fileName: "Launch plan.md",
      content: "# Launch plan\n",
      description: "Launch plan",
      visibility: "secret",
    });

    expect(result).toEqual({ kind: "unauthorized" });
  });

  it("reports a 404 for a token without the gist scope as rejected, not unreachable", async () => {
    const { command } = fakeCommand({
      exitCode: 1,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)",
    });
    const port = createGistCreationPort(command);

    const result = await port.create({
      fileName: "Launch plan.md",
      content: "# Launch plan\n",
      description: "Launch plan",
      visibility: "secret",
    });

    expect(result).toEqual({ kind: "rejected" });
  });

  it("keeps a rate limit unavailable rather than rejected", async () => {
    const { command } = fakeCommand({
      exitCode: 1,
      stdout: "",
      stderr: "gh: API rate limit exceeded (HTTP 403)",
    });
    const port = createGistCreationPort(command);

    const result = await port.create({
      fileName: "Launch plan.md",
      content: "# Launch plan\n",
      description: "Launch plan",
      visibility: "secret",
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("reports unavailable when gh cannot be reached", async () => {
    const command: GhCatalogueCommandPort = {
      run: async () => {
        throw new Error("gh-cli-unavailable");
      },
    };
    const port = createGistCreationPort(command);

    const result = await port.create({
      fileName: "Launch plan.md",
      content: "# Launch plan\n",
      description: "Launch plan",
      visibility: "secret",
    });

    expect(result).toEqual({ kind: "unavailable" });
  });

  it("reports unavailable when the response is not a gist", async () => {
    const { command } = fakeCommand({ exitCode: 0, stdout: "{}" });
    const port = createGistCreationPort(command);

    const result = await port.create({
      fileName: "Launch plan.md",
      content: "# Launch plan\n",
      description: "Launch plan",
      visibility: "secret",
    });

    expect(result).toEqual({ kind: "unavailable" });
  });
});
