import { describe, expect, it } from "vitest";
import {
  gitGlobalConfigReadRoots,
  prepareGitSeatbeltLaunch,
  resolveGitExecutable,
} from "./gitSeatbeltLaunch";
import type { SeatbeltConfinementPort } from "./seatbeltProfile";

describe("git Seatbelt launch", () => {
  it("lets confined git read the user's global config alongside the checkout", () => {
    let captured: Parameters<SeatbeltConfinementPort["prepare"]>[0] | undefined;
    const confinement: SeatbeltConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: "/usr/bin/sandbox-exec", args: [] };
      },
    };
    prepareGitSeatbeltLaunch({
      confinement,
      gitExecutable: "/opt/toolchain/usr/bin/git",
      checkoutRoot: "/repo",
      args: ["status"],
      temporaryDirectory: "/tmp",
      networkEgress: "allow",
    });
    const roots = captured?.readRoots ?? [];
    for (const root of gitGlobalConfigReadRoots()) expect(roots).toContain(root);
    expect(roots).toContain("/repo");
    expect(roots).toContain("/opt/toolchain/usr/bin");
  });

  it("derives global config roots from the home and XDG config directories", () => {
    const readConfig = () => undefined;
    expect(gitGlobalConfigReadRoots({ home: "/Users/example", env: {}, readConfig })).toEqual([
      "/Users/example/.gitconfig",
      "/Users/example/.config/git",
    ]);
    expect(
      gitGlobalConfigReadRoots({
        home: "/Users/example",
        env: { XDG_CONFIG_HOME: "/Users/example/xdg" },
        readConfig,
      }),
    ).toEqual(["/Users/example/.gitconfig", "/Users/example/xdg/git"]);
  });

  it("follows include and includeIf paths from the global config to a bounded depth", () => {
    const files = new Map<string, string>([
      [
        "/Users/example/.gitconfig",
        '[user]\n\tname = Example\n[include]\n\tpath = ~/.gitconfig.local\n\tpath = "relative/extra"\n[includeIf "gitdir:~/Dev/"]\n\tpath = /Users/example/Dev/.gitconfig-dev\n[alias]\n\tpath = not-an-include\n',
      ],
      [
        "/Users/example/.gitconfig.local",
        "[include]\n\tpath = ~/.gitconfig\n\tpath = ~/.gitconfig.work\n",
      ],
      ["/Users/example/.gitconfig.work", "[include]\n\tpath = ~/.gitconfig.local\n"],
    ]);
    expect(
      gitGlobalConfigReadRoots({
        home: "/Users/example",
        env: {},
        readConfig: (path) => files.get(path),
      }),
    ).toEqual([
      "/Users/example/.gitconfig",
      "/Users/example/.config/git",
      "/Users/example/.gitconfig.local",
      "/Users/example/.gitconfig.work",
      "/Users/example/relative/extra",
      "/Users/example/Dev/.gitconfig-dev",
    ]);
  });

  it("keeps an explicit executable and uses the plain system git off macOS", () => {
    expect(resolveGitExecutable("/custom/git", "darwin")).toBe("/custom/git");
    expect(resolveGitExecutable(undefined, "linux")).toBe("/usr/bin/git");
    expect(() => resolveGitExecutable("git", "darwin")).toThrow(/absolute/);
  });
});
