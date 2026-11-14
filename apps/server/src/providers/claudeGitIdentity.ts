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
 * config file, so only the fields the checkout does not set itself are passed
 * (see {@link readClaudeGitIdentity}); a checkout's own identity keeps winning.
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
 * Reads the person's global `user.name` and `user.email` from the server
 * process, which the sandbox does not hold, leaving out each field the
 * checkout sets in its own config. A field git cannot read is left out.
 */
export async function readClaudeGitIdentity(checkoutRoot: string): Promise<ClaudeGitIdentity> {
  const read = (args: ReadonlyArray<string>) =>
    new Promise<string | undefined>((resolve) => {
      execFile("git", [...args], { timeout: 2_000, windowsHide: true }, (error, stdout) => {
        const value = error === null ? stdout.trim() : "";
        resolve(value === "" || value.includes("\n") ? undefined : value);
      });
    });
  const field = async (key: "user.name" | "user.email") => {
    const local = await read(["-C", checkoutRoot, "config", "--local", "--get", key]);
    return local === undefined ? read(["config", "--global", "--get", key]) : undefined;
  };
  const [name, email] = await Promise.all([field("user.name"), field("user.email")]);
  return {
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
  };
}
