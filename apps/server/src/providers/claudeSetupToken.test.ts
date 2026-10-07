import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readSetupTokenOutput,
  runClaudeSetupToken,
  type SetupTokenTerminal,
  type SpawnSetupTokenTerminal,
} from "./claudeSetupToken";

const TOKEN = "sk-ant-oat01-fixture_Token-0123456789abcdefghij";

/** Frames shaped like the program's own output: colour, a redrawn spinner, then the token. */
const FRAMES = [
  "\u001b[?25l\u001b[2mOpening browser to sign in…\u001b[22m\r\n",
  "\u001b[1A\u001b[2K\u001b[32m✓ Long-lived authentication token created successfully!\u001b[39m\r\n\r\n",
  "Your OAuth token (valid for 1 year):\r\n\r\n",
  `\u001b[33m${TOKEN}\u001b[39m\r\n\r\n`,
  "\u001b[2mStore this token securely. You won't be able to see it again.\u001b[22m\r\n",
];

function fakeTerminal() {
  const data = new Set<(chunk: string) => void>();
  const exit = new Set<() => void>();
  const spawned: Parameters<SpawnSetupTokenTerminal>[0][] = [];
  const terminal: SetupTokenTerminal & { killed: boolean } = {
    killed: false,
    onData: (listener) => {
      data.add(listener);
      return () => data.delete(listener);
    },
    onExit: (listener) => {
      exit.add(listener);
      return () => exit.delete(listener);
    },
    kill: () => {
      terminal.killed = true;
    },
  };
  const spawn: SpawnSetupTokenTerminal = (input) => {
    spawned.push(input);
    return terminal;
  };
  return {
    spawn,
    spawned,
    terminal,
    write: (chunk: string) => {
      for (const listener of data) listener(chunk);
    },
    exit: () => {
      for (const listener of exit) listener();
    },
  };
}

const consoleSpies = () =>
  (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connecting Claude for helpers", () => {
  it("captures the printed token without passing it as an argument or logging it", async () => {
    const spies = consoleSpies();
    const fake = fakeTerminal();
    const outcome = runClaudeSetupToken({
      binaryPath: "/usr/local/bin/claude",
      cwd: "/tmp/connect",
      environment: { PATH: "/usr/bin" },
      spawn: fake.spawn,
    });
    for (const frame of FRAMES) fake.write(frame);

    await expect(outcome).resolves.toEqual({ kind: "captured", token: TOKEN });
    expect(fake.spawned).toHaveLength(1);
    expect(fake.spawned[0]?.args).toEqual(["setup-token"]);
    expect(JSON.stringify(fake.spawned)).not.toContain(TOKEN);
    // Wide enough that the token is never wrapped across two lines.
    expect(fake.spawned[0]?.columns).toBeGreaterThan(TOKEN.length);
    expect(fake.terminal.killed).toBe(true);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    }
  });

  it("reads a token split across output chunks", () => {
    const output = FRAMES.join("");
    const end = output.indexOf(TOKEN) + TOKEN.length;
    expect(readSetupTokenOutput(output.slice(0, output.indexOf(TOKEN) + 10))).toBeUndefined();
    // A prefix long enough to pass for a token is not one until the line ends.
    expect(readSetupTokenOutput(output.slice(0, output.indexOf(TOKEN) + 20))).toBeUndefined();
    expect(readSetupTokenOutput(output.slice(0, end))).toBeUndefined();
    // Half of the colour reset that follows the token is not part of it.
    expect(readSetupTokenOutput(output.slice(0, end + 3))).toBeUndefined();
    expect(readSetupTokenOutput(output)).toBe(TOKEN);
  });

  it("keeps the whole token when the terminal delivers it in pieces", async () => {
    const fake = fakeTerminal();
    const outcome = runClaudeSetupToken({
      binaryPath: "/usr/local/bin/claude",
      cwd: "/tmp/connect",
      environment: {},
      spawn: fake.spawn,
    });
    const output = FRAMES.join("");
    const cut = output.indexOf(TOKEN) + 20;
    fake.write(output.slice(0, cut));
    fake.write(output.slice(cut));

    await expect(outcome).resolves.toEqual({ kind: "captured", token: TOKEN });
  });

  it("reports a sign-in that ended without a token and never echoes the program's output", async () => {
    const fake = fakeTerminal();
    const outcome = runClaudeSetupToken({
      binaryPath: "/usr/local/bin/claude",
      cwd: "/tmp/connect",
      environment: {},
      spawn: fake.spawn,
    });
    fake.write("OAuth error: something private-detail\r\n");
    fake.exit();

    const settled = await outcome;
    expect(settled).toEqual({
      kind: "refused",
      reason: "Claude did not finish connecting. Try again.",
    });
    expect(JSON.stringify(settled)).not.toContain("private-detail");
  });

  it("stops waiting for the browser after its deadline", async () => {
    const fake = fakeTerminal();
    await expect(
      runClaudeSetupToken({
        binaryPath: "/usr/local/bin/claude",
        cwd: "/tmp/connect",
        environment: {},
        spawn: fake.spawn,
        timeoutMs: 5,
      }),
    ).resolves.toEqual({ kind: "refused", reason: "Connecting Claude timed out. Try again." });
    expect(fake.terminal.killed).toBe(true);
  });
});
