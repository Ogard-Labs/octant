import { execFile } from "node:child_process";

/** The person's own git identity, each field present only when set. */
export interface ClaudeGitIdentity {
  readonly name?: string;
  readonly email?: string;
}

/**
 * The environment that carries the person's git identity into commits Claude
 * makes inside its command sandbox. The sandbox denies `~/.gitconfig`, so a
 * sandboxed `git commit` found no identity and failed or used git's guess from
 * the OS account. Git reads `GIT_AUTHOR_*` and `GIT_COMMITTER_*` before any
 * config file, so the values passed are the ones git would resolve in the
 * checkout (see {@link readClaudeGitIdentity}); a checkout's own identity
 * keeps winning.
 */
export function claudeGitIdentityEnvironment(
  identity: ClaudeGitIdentity,
): Readonly<Record<string, string>> {
  return {
    ...(identity.name === undefined
      ? {}
      : { GIT_AUTHOR_NAME: identity.name, GIT_COMMITTER_NAME: identity.name }),
    ...(identity.email === undefined
      ? {}
      : { GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_EMAIL: identity.email }),
  };
}

/**
 * Reads the `user.name` and `user.email` git itself would use in the
 * checkout, from the server process, which the sandbox does not hold: every
 * scope (system, global, the checkout's own) and every `include` and
 * `includeIf` file. Reading only the `--global` file missed an identity set
 * through `includeIf "gitdir:..."`, so a commit in a work checkout carried the
 * person's home address. A field git cannot read is left out.
 */
export async function readClaudeGitIdentity(checkoutRoot: string): Promise<ClaudeGitIdentity> {
  const field = (key: "user.name" | "user.email") =>
    new Promise<string | undefined>((resolve) => {
      execFile(
        "git",
        ["-C", checkoutRoot, "config", "--includes", "--get", key],
        { timeout: 2_000, windowsHide: true },
        (error, stdout) => {
          const value = error === null ? stdout.trim() : "";
          resolve(value === "" || value.includes("\n") ? undefined : value);
        },
      );
    });
  const [name, email] = await Promise.all([field("user.name"), field("user.email")]);
  return {
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
  };
}
