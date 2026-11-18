import { describe, expect, it, vi } from "vitest";
import { decodeProviderInstanceId } from "@octant/contracts";
import {
  checkAccountSignIn,
  startAccountSignIn,
  type AccountSignInProcess,
  type AccountSignInSpawn,
} from "./accountSignIn";

const instanceId = decodeProviderInstanceId("8a4f3c1e-2b7d-4e5f-9a6b-1c2d3e4f5a6b");

function fakeCli() {
  let output: (chunk: string) => void = () => undefined;
  let exit: (code: number | null) => void = () => undefined;
  const written: string[] = [];
  const stop = vi.fn();
  const process: AccountSignInProcess = {
    onOutput: (listener) => {
      output = listener;
    },
    onExit: (listener) => {
      exit = listener;
    },
    writeLine: (line) => {
      written.push(line);
    },
    stop,
  };
  const calls: Array<{ binaryPath: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv }> =
    [];
  const spawn: AccountSignInSpawn = (binaryPath, args, env) => {
    calls.push({ binaryPath, args, env });
    return process;
  };
  return {
    spawn,
    calls,
    written,
    stop,
    print: (chunk: string) => output(chunk),
    exit: (code: number | null) => exit(code),
  };
}

const command = {
  instanceId,
  binaryPath: "/opt/claude/bin/claude",
  args: ["auth", "login"],
  environment: { CLAUDE_CONFIG_DIR: "/Users/example/.claude-accounts/a" },
  codeEntry: true,
} as const;

describe("account sign-in through the account's own CLI", () => {
  it("runs the unmodified sign-in command under the account directory and offers the page it prints", async () => {
    const cli = fakeCli();
    const started = startAccountSignIn(command, cli.spawn);
    cli.print(
      "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\n",
    );
    await expect(started).resolves.toMatchObject({
      status: "started",
      signInUrl: "https://claude.com/cai/oauth/authorize?code=true",
    });
    expect(cli.calls).toEqual([
      {
        binaryPath: "/opt/claude/bin/claude",
        args: ["auth", "login"],
        env: { CLAUDE_CONFIG_DIR: "/Users/example/.claude-accounts/a" },
      },
    ]);
  });

  it("offers the whole sign-in page when the CLI writes its address in pieces", async () => {
    const cli = fakeCli();
    const started = startAccountSignIn(command, cli.spawn);
    cli.print("visit: https://claude.com/cai/oauth/auth");
    cli.print("orize?code=true&state=abc\nPaste code here if prompted > ");
    await expect(started).resolves.toMatchObject({
      status: "started",
      signInUrl: "https://claude.com/cai/oauth/authorize?code=true&state=abc",
    });
  });

  it("stays pending until the CLI finishes, then reports the account signed in", async () => {
    const cli = fakeCli();
    const started = startAccountSignIn(command, cli.spawn);
    cli.print("visit: https://claude.com/cai/oauth/authorize\n");
    const attempt = await started;
    if (attempt.status !== "started") throw new Error("expected a started sign-in");
    expect(checkAccountSignIn({ instanceId, attemptId: attempt.attemptId })).toEqual({
      status: "pending",
    });
    cli.exit(0);
    expect(checkAccountSignIn({ instanceId, attemptId: attempt.attemptId })).toEqual({
      status: "completed",
    });
    expect(checkAccountSignIn({ instanceId, attemptId: attempt.attemptId })).toMatchObject({
      status: "failed",
    });
  });

  it("hands a pasted code to the CLI's input as one line", async () => {
    const cli = fakeCli();
    const started = startAccountSignIn(command, cli.spawn);
    cli.print("visit: https://claude.com/cai/oauth/authorize\nPaste code here if prompted > ");
    const attempt = await started;
    if (attempt.status !== "started") throw new Error("expected a started sign-in");
    checkAccountSignIn({ instanceId, attemptId: attempt.attemptId, code: "abc#def" });
    expect(cli.written).toEqual(["abc#def"]);
  });

  it("reports the CLI's own last line when the sign-in fails", async () => {
    const cli = fakeCli();
    const started = startAccountSignIn(command, cli.spawn);
    cli.print("visit: https://claude.com/cai/oauth/authorize\n");
    const attempt = await started;
    if (attempt.status !== "started") throw new Error("expected a started sign-in");
    cli.print("\u001b[31mOAuth error: invalid code\u001b[0m\n");
    cli.exit(1);
    expect(checkAccountSignIn({ instanceId, attemptId: attempt.attemptId })).toEqual({
      status: "failed",
      message: "OAuth error: invalid code",
    });
  });

  it("refuses a sign-in check for another account", async () => {
    const cli = fakeCli();
    const started = startAccountSignIn(command, cli.spawn);
    cli.print("visit: https://claude.com/cai/oauth/authorize\n");
    const attempt = await started;
    if (attempt.status !== "started") throw new Error("expected a started sign-in");
    const other = decodeProviderInstanceId("1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d");
    expect(checkAccountSignIn({ instanceId: other, attemptId: attempt.attemptId })).toMatchObject({
      status: "failed",
    });
  });

  it("stops the earlier sign-in when the same account starts another", async () => {
    const first = fakeCli();
    const firstStarted = startAccountSignIn(command, first.spawn);
    first.print("visit: https://claude.com/cai/oauth/authorize\n");
    await firstStarted;
    const second = fakeCli();
    void startAccountSignIn(command, second.spawn);
    expect(first.stop).toHaveBeenCalledTimes(1);
  });
});
