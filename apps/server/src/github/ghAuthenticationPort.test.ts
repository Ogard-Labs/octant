import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractDeviceFlowCode,
  GhAuthenticationPort,
  sanitizedEnvironment,
} from "./ghAuthenticationPort";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("GhAuthenticationPort", () => {
  it("uses the token-free status command and a sanitized environment", async () => {
    const command = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [
              {
                login: "octant",
                active: true,
                scopes: "repo, read:org",
                tokenSource: "keyring",
                gitProtocol: "https",
              },
            ],
          },
        }),
      })),
    };
    const port = new GhAuthenticationPort({
      command,
      inheritedEnvironment: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        GH_CONFIG_DIR: "/home/test/.config/gh-work",
      },
    });
    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "observed",
      accounts: [
        {
          login: "octant",
          source: "keyring",
          scopes: ["repo", "read:org"],
          gitProtocol: "https",
        },
      ],
    });
    expect(command.run).toHaveBeenCalledWith(
      ["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
      expect.objectContaining({
        environment: expect.objectContaining({ GH_CONFIG_DIR: "/home/test/.config/gh-work" }),
      }),
      expect.any(AbortSignal),
    );
    expect(sanitizedEnvironment({ GH_TOKEN: "secret", GITHUB_TOKEN: "other" })).not.toMatchObject({
      GH_TOKEN: expect.anything(),
      GITHUB_TOKEN: expect.anything(),
    });
  });

  it("accepts the current gh account host field without widening the host scope", async () => {
    const command = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [
              {
                host: "github.com",
                login: "octant",
                active: true,
                scopes: "repo",
                tokenSource: "keyring",
                gitProtocol: "https",
              },
            ],
          },
        }),
      })),
    };
    const port = new GhAuthenticationPort({ command, inheritedEnvironment: {} });

    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "observed",
      accounts: [
        {
          login: "octant",
          source: "keyring",
          scopes: ["repo"],
          gitProtocol: "https",
        },
      ],
    });
  });

  it("refuses to inherit ambient token precedence without spawning gh", async () => {
    const command = { run: vi.fn() };
    const port = new GhAuthenticationPort({
      command,
      inheritedEnvironment: { GH_TOKEN: "secret" },
    });
    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "external-token",
    });
    expect(command.run).not.toHaveBeenCalled();
  });

  it("ignores empty ambient token variables", async () => {
    const command = {
      run: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ hosts: {} }) })),
    };
    const port = new GhAuthenticationPort({
      command,
      inheritedEnvironment: { GH_TOKEN: "", GITHUB_TOKEN: "" },
    });

    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "unauthorized",
    });
    expect(command.run).toHaveBeenCalledOnce();
  });

  it("classifies rate-limit and incompatible status failures without exposing stderr", async () => {
    const rateLimited = new GhAuthenticationPort({
      command: {
        run: async () => ({ exitCode: 1, stdout: "", stderr: "API rate limit exceeded" }),
      },
      inheritedEnvironment: {},
    });
    const incompatible = new GhAuthenticationPort({
      command: { run: async () => ({ exitCode: 1, stdout: "", stderr: "unexpected response" }) },
      inheritedEnvironment: {},
    });
    await expect(rateLimited.observe(new AbortController().signal)).resolves.toEqual({
      kind: "rate-limited",
    });
    await expect(incompatible.observe(new AbortController().signal)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("bounds a stalled status observation and propagates its deadline to the owned command", async () => {
    let deadlineObserved = false;
    const port = new GhAuthenticationPort({
      command: {
        run: (_arguments, _options, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                deadlineObserved = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      },
      inheritedEnvironment: {},
      statusObservationTimeoutMs: 1,
    });

    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "unavailable",
    });
    expect(deadlineObserved).toBe(true);
  });

  it("accepts gh's current device-code prompt wording", () => {
    expect(extractDeviceFlowCode("First, copy your one-time code: ABCD-EFGH")).toBe("ABCD-EFGH");
  });

  it("releases command-owned interactive children on server shutdown", () => {
    const close = vi.fn();
    const port = new GhAuthenticationPort({
      command: { run: vi.fn(), close },
      inheritedEnvironment: {},
    });

    port.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it("classifies gh's successful empty-host JSON as unauthorized", async () => {
    const port = new GhAuthenticationPort({
      command: { run: async () => ({ exitCode: 0, stdout: JSON.stringify({ hosts: {} }) }) },
      inheritedEnvironment: {},
    });

    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "unauthorized",
    });
  });

  it.each([
    ["an extra root field", { hosts: {}, ignored: true }],
    ["an extra host", { hosts: { "github.com": [], "github.example": [] } }],
    [
      "an extra healthy-account field",
      {
        hosts: {
          "github.com": [
            {
              login: "octant",
              active: true,
              scopes: "repo",
              tokenSource: "keyring",
              gitProtocol: "https",
              ignored: true,
            },
          ],
        },
      },
    ],
    [
      "an extra error-account field",
      {
        hosts: {
          "github.com": [
            {
              login: "octant",
              active: true,
              state: "error",
              error: "authentication required",
              gitProtocol: "https",
              ignored: true,
            },
          ],
        },
      },
    ],
  ])("fails closed when status JSON contains %s", async (_label, payload) => {
    const port = new GhAuthenticationPort({
      command: { run: async () => ({ exitCode: 0, stdout: JSON.stringify(payload) }) },
      inheritedEnvironment: {},
    });

    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("classifies an active gh account in an error state as unauthorized before reading scopes", async () => {
    const port = new GhAuthenticationPort({
      command: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            hosts: {
              "github.com": [
                {
                  login: "octant",
                  active: true,
                  state: "error",
                  gitProtocol: "https",
                },
              ],
            },
          }),
        }),
      },
      inheritedEnvironment: {},
    });

    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "unauthorized",
    });
  });

  it.each([
    ["rate limit", "API rate limit exceeded", "rate-limited"],
    ["network failure", "dial tcp: network is unreachable", "unavailable"],
  ] as const)(
    "classifies a transient active-account %s without prompting reauthentication",
    async (_label, error, kind) => {
      const port = new GhAuthenticationPort({
        command: {
          run: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              hosts: {
                "github.com": [
                  {
                    login: "octant",
                    active: true,
                    state: "error",
                    error,
                    gitProtocol: "https",
                  },
                ],
              },
            }),
          }),
        },
        inheritedEnvironment: {},
      });

      await expect(port.observe(new AbortController().signal)).resolves.toEqual({ kind });
    },
  );

  it("normalizes a plaintext hosts.yml token source without exposing its path", async () => {
    const port = new GhAuthenticationPort({
      command: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            hosts: {
              "github.com": [
                {
                  login: "octant",
                  active: true,
                  scopes: "repo",
                  tokenSource: "/home/user/.config/gh/hosts.yml",
                  gitProtocol: "https",
                },
              ],
            },
          }),
        }),
      },
      inheritedEnvironment: {},
    });

    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "observed",
      accounts: [
        { login: "octant", source: "config-file", scopes: ["repo"], gitProtocol: "https" },
      ],
    });
  });

  it("refuses setup before gh can fall back to plaintext credential storage", async () => {
    const command = { run: vi.fn() };
    const port = new GhAuthenticationPort({
      command,
      inheritedEnvironment: {},
      secureStorage: { isAvailable: async () => false },
    });

    await expect(
      port.execute(
        { kind: "setup", confirmation: "confirm-github-setup" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("secure-storage-unavailable");
    expect(command.run).not.toHaveBeenCalled();
  });

  it("refuses refresh before gh can replace a credential through plaintext storage", async () => {
    const command = { run: vi.fn(), beginInteractive: vi.fn() };
    const port = new GhAuthenticationPort({
      command,
      inheritedEnvironment: {},
      secureStorage: { isAvailable: async () => false },
    });

    await expect(
      port.execute(
        { kind: "refresh", confirmation: "confirm-github-refresh", scopes: ["read:project"] },
        new AbortController().signal,
      ),
    ).rejects.toThrow("secure-storage-unavailable");
    expect(command.run).not.toHaveBeenCalled();
    expect(command.beginInteractive).not.toHaveBeenCalled();
  });

  it("treats gh exit code 4 as an authentication requirement, not a rate limit", async () => {
    const port = new GhAuthenticationPort({
      command: {
        run: async () => ({ exitCode: 4, stdout: "", stderr: "authentication required" }),
      },
      inheritedEnvironment: {},
    });
    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "unauthorized",
    });
  });

  it("does not start a lifecycle child when the caller was already aborted", async () => {
    const command = { run: vi.fn() };
    const port = new GhAuthenticationPort({
      command,
      inheritedEnvironment: {},
      secureStorage: { isAvailable: async () => true },
    });
    const controller = new AbortController();
    controller.abort(new Error("caller-disconnected"));

    await expect(
      port.execute(
        { kind: "refresh", confirmation: "confirm-github-refresh", scopes: ["read:project"] },
        controller.signal,
      ),
    ).rejects.toThrow("caller-disconnected");
    expect(command.run).not.toHaveBeenCalled();
  });

  it("returns a bounded device-flow interaction while the headless login continues", async () => {
    const beginInteractive = vi.fn(async () => ({
      kind: "device-flow" as const,
      userCode: "ABCD-EFGH",
      completion: Promise.resolve(),
    }));
    const port = new GhAuthenticationPort({
      command: { run: vi.fn(), beginInteractive },
      inheritedEnvironment: {},
      secureStorage: { isAvailable: async () => true },
    });

    await expect(
      port.execute(
        { kind: "setup", confirmation: "confirm-github-setup" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "device-flow", userCode: "ABCD-EFGH" });
    expect(beginInteractive).toHaveBeenCalledOnce();
  });

  it("returns the same bounded device-flow interaction for a scope refresh", async () => {
    const beginInteractive = vi.fn(async () => ({
      kind: "device-flow" as const,
      userCode: "WXYZ-1234",
      completion: Promise.resolve(),
    }));
    const port = new GhAuthenticationPort({
      command: { run: vi.fn(), beginInteractive },
      inheritedEnvironment: {},
      secureStorage: { isAvailable: async () => true },
    });

    await expect(
      port.execute(
        {
          kind: "refresh",
          confirmation: "confirm-github-refresh",
          scopes: ["read:project"],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "device-flow", userCode: "WXYZ-1234" });
    expect(beginInteractive).toHaveBeenCalledWith(
      ["auth", "refresh", "--hostname", "github.com", "--scopes", "read:project"],
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it("rejects competing lifecycle commands until the server-owned device flow completes", async () => {
    let completeFlow!: () => void;
    const completion = new Promise<void>((resolve) => {
      completeFlow = resolve;
    });
    const command = {
      run: vi.fn(async (arguments_: readonly string[]) => ({
        exitCode: 0,
        stdout:
          arguments_[0] === "auth" && arguments_[1] === "status"
            ? JSON.stringify({
                hosts: {
                  "github.com": [
                    {
                      login: "octant",
                      active: true,
                      scopes: "repo",
                      tokenSource: "keyring",
                      gitProtocol: "https",
                    },
                  ],
                },
              })
            : "",
      })),
      beginInteractive: vi.fn(async () => ({
        kind: "device-flow" as const,
        userCode: "WXYZ-1234",
        completion,
      })),
    };
    const port = new GhAuthenticationPort({
      command,
      inheritedEnvironment: {},
      secureStorage: { isAvailable: async () => true },
    });

    await expect(
      port.execute(
        { kind: "refresh", confirmation: "confirm-github-refresh", scopes: ["read:project"] },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "device-flow", userCode: "WXYZ-1234" });
    await expect(
      port.execute(
        { kind: "logout", confirmation: "confirm-github-local-logout" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("github-authentication-in-progress");

    completeFlow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      port.execute(
        { kind: "logout", confirmation: "confirm-github-local-logout" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "completed" });
  });

  it("targets the observed active account for a non-interactive local logout", async () => {
    const command = {
      run: vi.fn(async (arguments_: readonly string[]) => {
        if (arguments_[0] === "auth" && arguments_[1] === "status") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              hosts: {
                "github.com": [
                  {
                    login: "octant",
                    active: true,
                    scopes: "repo",
                    tokenSource: "keyring",
                    gitProtocol: "https",
                  },
                ],
              },
            }),
          };
        }
        return { exitCode: 0, stdout: "" };
      }),
    };
    const port = new GhAuthenticationPort({ command, inheritedEnvironment: {} });

    await expect(
      port.execute(
        { kind: "logout", confirmation: "confirm-github-local-logout" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "completed" });

    expect(command.run).toHaveBeenLastCalledWith(
      ["auth", "logout", "--hostname", "github.com", "--user", "octant"],
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it("uses only a resolved compatible gh executable for observation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-gh-auth-"));
    directories.push(directory);
    const executable = join(directory, "approved-gh");
    writeFileSync(
      executable,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  printf "gh version 2.46.0 (test)\\n"',
        "else",
        "  printf '{\"hosts\":{}}\\n'",
        "fi",
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(executable, 0o700);
    const port = new GhAuthenticationPort({
      ghExecutable: executable,
      inheritedEnvironment: { PATH: directory },
    });

    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "unauthorized",
    });
  });

  it("rejects an unresolved or unsupported gh executable before status or lifecycle commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-gh-auth-"));
    directories.push(directory);
    const executable = join(directory, "old-gh");
    writeFileSync(executable, '#!/bin/sh\nprintf "gh version 2.44.9 (test)\\n"\n', { mode: 0o700 });
    chmodSync(executable, 0o700);
    const port = new GhAuthenticationPort({
      ghExecutable: executable,
      inheritedEnvironment: { PATH: directory },
      secureStorage: { isAvailable: async () => true },
    });

    await expect(port.observe(new AbortController().signal)).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(
      port.execute(
        { kind: "logout", confirmation: "confirm-github-local-logout" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("gh-cli-unsupported");
  });

  it("preserves the validated Secret Service session for both the probe and gh", async () => {
    const command = {
      run: vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ hosts: {} }) })),
    };
    const port = new GhAuthenticationPort({
      command,
      inheritedEnvironment: {
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus,guid=abcd",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
    });

    await port.observe(new AbortController().signal);

    expect(command.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environment: expect.objectContaining({
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus,guid=abcd",
          XDG_RUNTIME_DIR: "/run/user/1000",
        }),
      }),
      expect.any(AbortSignal),
    );
  });
});
