/**
 * The pushes and pull-request changes a shell command makes, read from the
 * command as written, and the hard lines Octant holds on them where nothing
 * else reviews the command. Canonical: docs/architecture.md § Modes (Git and
 * pull requests) and § Octant Shield.
 *
 * At Full access the provider's own `git` and forge command-line tool are the
 * person's choice, so a push or a pull-request change through the shell is
 * journaled rather than asked about. Three acts stay the person's even there:
 * a merge, a plain force-push (each needs the person's approval for that one
 * act, which a standing Full access grant does not stand in for), and a push
 * to another thread's branch (never). A command that reads as one of those is
 * refused before it runs where Octant runs it; a command whose target hides
 * behind an expansion is recorded as unreadable, since a word check cannot
 * tell where it goes.
 */

export type ForgePushForce = "none" | "with-lease" | "plain";

export type ForgeShellChange =
  | {
      readonly kind: "push";
      /** Remote branches the push names; empty when it pushes the current branch. */
      readonly branches: ReadonlyArray<string>;
      /** `--all` or `--mirror`: every local branch, which in a shared repository includes other threads'. */
      readonly allBranches: boolean;
      readonly force: ForgePushForce;
      readonly deletes: boolean;
      /** The target hides behind an expansion, so the branches above may be incomplete. */
      readonly unreadable: boolean;
    }
  | { readonly kind: "merge"; readonly unreadable: boolean }
  | { readonly kind: "pull-request"; readonly unreadable: boolean };

export type ForgeShellHardLine = "merge-not-asked" | "force-push-not-asked" | "other-thread-branch";

const MAX_NESTING = 3;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PREFIX_WORDS = new Set([
  "sudo",
  "command",
  "env",
  "nohup",
  "time",
  "exec",
  "builtin",
  "nice",
  "stdbuf",
  "xargs",
  "watch",
  "timeout",
]);
/** Words that open or continue a compound command; what follows them is the command. */
const CONTROL_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "{",
  "}",
]);
/** Wrapper options that take the next word as their value. */
const WRAPPER_OPTIONS_WITH_VALUE = new Set(["-u", "-g", "-n", "-I", "-L", "-P", "-s", "-d", "-k"]);
const PULL_REQUEST_SUBCOMMANDS = new Set([
  "create",
  "edit",
  "close",
  "reopen",
  "ready",
  "comment",
  "review",
  "lock",
  "unlock",
]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PUSH_OPTIONS_WITH_VALUE = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
]);

interface Segment {
  readonly words: ReadonlyArray<string>;
  /** A word holds an expansion, a glob, or an escape the shell resolves at run time. */
  readonly expands: boolean;
}

/**
 * Splits a command into its simple commands, quote-aware: separators,
 * pipes, subshells and substitutions end one. Quotes are taken off a word;
 * a `$`, a backtick, a glob, or an escape outside single quotes marks the
 * segment as one whose words the shell may still change.
 */
function segmentsOf(text: string): ReadonlyArray<Segment> {
  const segments: Segment[] = [];
  let words: string[] = [];
  let current = "";
  let inWord = false;
  let expands = false;
  const endWord = () => {
    if (inWord) words.push(current);
    current = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push({ words, expands });
    words = [];
    expands = false;
  };
  // A here-document's body is data for its command, not commands: a commit
  // message that mentions `gh pr merge` is not a merge.
  const heredocs: Array<{ readonly delimiter: string; readonly tabs: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "<" && text.charAt(index + 1) === "<" && text.charAt(index + 2) !== "<") {
      const opened = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(text.slice(index));
      if (opened !== null) {
        heredocs.push({ delimiter: opened[3] ?? "", tabs: opened[1] === "-" });
        index += opened[0].length - 1;
        continue;
      }
    }
    if (char === "\n" && heredocs.length > 0) {
      endSegment();
      let cursor = index + 1;
      for (const heredoc of heredocs.splice(0)) {
        for (;;) {
          const end = text.indexOf("\n", cursor);
          const line = text.slice(cursor, end === -1 ? text.length : end);
          cursor = end === -1 ? text.length : end + 1;
          if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
          if (end === -1) break;
        }
      }
      index = cursor - 1;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      const stop = end === -1 ? text.length : end;
      current += text.slice(index + 1, stop);
      inWord = true;
      index = stop;
      continue;
    }
    if (char === '"') {
      const end = text.indexOf('"', index + 1);
      const stop = end === -1 ? text.length : end;
      const inner = text.slice(index + 1, stop);
      if (/[$`\\]/.test(inner)) expands = true;
      current += inner;
      inWord = true;
      index = stop;
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    // A comment runs to the end of its line; its words are not arguments.
    if (char === "#" && !inWord) {
      const end = text.indexOf("\n", index);
      index = (end === -1 ? text.length : end) - 1;
      continue;
    }
    if (/[;&|()`\r\n]/.test(char)) {
      if (char === "`") expands = true;
      endSegment();
      continue;
    }
    if (char === "$") {
      if (text.charAt(index + 1) === "(") {
        endSegment();
        index += 1;
        continue;
      }
      expands = true;
    }
    if (/[\\*?[\]{}~]/.test(char)) expands = true;
    current += char;
    inWord = true;
  }
  endSegment();
  return segments;
}

/** The words a segment runs, past variable assignments and wrappers such as `sudo` or `env`. */
function commandWords(words: ReadonlyArray<string>): ReadonlyArray<string> {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || CONTROL_WORDS.has(word)) {
      index += 1;
      continue;
    }
    const wrapper = programName(word);
    if (PREFIX_WORDS.has(wrapper)) {
      index += 1;
      // `sudo -u x`, `xargs -n 1`: a wrapper's own options are not the command.
      while (index < words.length && (words[index] ?? "").startsWith("-")) {
        index += WRAPPER_OPTIONS_WITH_VALUE.has(words[index] ?? "") ? 2 : 1;
      }
      // `timeout 60 git push`: its duration comes before the command.
      if (wrapper === "timeout" && index < words.length) index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function programName(word: string): string {
  // `\git` runs `git`, skipping any alias of that name.
  const bare = word.startsWith("\\") ? word.slice(1) : word;
  const slash = bare.lastIndexOf("/");
  return slash === -1 ? bare : bare.slice(slash + 1);
}

function branchOf(ref: string): string | undefined {
  if (ref.length === 0) return undefined;
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/")) return undefined;
  return ref;
}

function readPush(args: ReadonlyArray<string>, expands: boolean): ForgeShellChange {
  let force: ForgePushForce = "none";
  let deletes = false;
  let allBranches = false;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (PUSH_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0] ?? arg;
      if (name === "--force") force = "plain";
      else if (name === "--force-with-lease" || name === "--force-if-includes") {
        if (force === "none") force = "with-lease";
      } else if (name === "--mirror") {
        force = "plain";
        deletes = true;
        allBranches = true;
      } else if (name === "--all" || name === "--branches") allBranches = true;
      else if (name === "--delete") deletes = true;
      else if (name === "--prune") deletes = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      // A cluster: `-fu` is `-f -u`; `-o` takes the rest as its value.
      for (const flag of arg.slice(1)) {
        if (flag === "o") break;
        if (flag === "f") force = "plain";
        if (flag === "d") deletes = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  const branches: string[] = [];
  for (const refspec of positionals.slice(1)) {
    let spec = refspec;
    if (spec.startsWith("+")) {
      force = "plain";
      spec = spec.slice(1);
    }
    const colon = spec.indexOf(":");
    if (colon === -1) {
      if (spec === "HEAD") continue;
      const branch = branchOf(spec);
      if (branch !== undefined) branches.push(branch);
      continue;
    }
    if (colon === 0) deletes = true;
    const branch = branchOf(spec.slice(colon + 1));
    if (branch !== undefined) branches.push(branch);
  }
  return { kind: "push", branches, allBranches, force, deletes, unreadable: expands };
}

function readGh(args: ReadonlyArray<string>, text: string, expands: boolean): ForgeShellChange[] {
  const [group, action] = args;
  if (group === "pr") {
    if (action === "merge") return [{ kind: "merge", unreadable: expands }];
    if (action !== undefined && PULL_REQUEST_SUBCOMMANDS.has(action)) {
      return [{ kind: "pull-request", unreadable: expands }];
    }
    return [];
  }
  if (group !== "api") return [];
  const rest = args.slice(1);
  if (rest.includes("graphql")) {
    return /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/.test(text)
      ? [{ kind: "merge", unreadable: expands }]
      : /\b(?:createPullRequest|updatePullRequest|closePullRequest|reopenPullRequest|addPullRequestReview\w*)\b/.test(
            text,
          )
        ? [{ kind: "pull-request", unreadable: expands }]
        : [];
  }
  const path = rest.find((arg) => /(?:^|\/)repos\/[^/]+\/[^/]+\/pulls\b/.test(arg));
  if (path === undefined) return [];
  // `gh api` sends GET unless told otherwise, or POST once fields are given.
  const writes = rest.some(
    (arg, index) =>
      ((arg === "-X" || arg === "--method") &&
        /^(?:POST|PATCH|PUT|DELETE)$/i.test(rest[index + 1] ?? "")) ||
      /^--method=(?:POST|PATCH|PUT|DELETE)$/i.test(arg) ||
      /^-X(?:POST|PATCH|PUT|DELETE)$/i.test(arg) ||
      ["-f", "-F", "--field", "--raw-field", "--input"].includes(arg) ||
      /^--(?:field|raw-field|input)=/.test(arg),
  );
  if (!writes) return [];
  return /\/pulls\/[^/]+\/merge\b/.test(path)
    ? [{ kind: "merge", unreadable: expands }]
    : [{ kind: "pull-request", unreadable: expands }];
}

function changesIn(text: string, depth: number): ForgeShellChange[] {
  const changes: ForgeShellChange[] = [];
  for (const segment of segmentsOf(text)) {
    const words = commandWords(segment.words);
    const program = programName(words[0] ?? "");
    if (SHELLS.has(program) && depth < MAX_NESTING) {
      // `-c`, or a cluster that holds it (`-lc`, `-ec`): the next word is the script.
      const script = words.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
      const inner = script === -1 ? undefined : words[script + 1];
      if (inner !== undefined) changes.push(...changesIn(inner, depth + 1));
      continue;
    }
    if (program === "eval" && depth < MAX_NESTING) {
      changes.push(...changesIn(words.slice(1).join(" "), depth + 1));
      continue;
    }
    if (program === "git") {
      let index = 1;
      while (index < words.length && (words[index] ?? "").startsWith("-")) {
        index += GIT_OPTIONS_WITH_VALUE.has(words[index] ?? "") ? 2 : 1;
      }
      if (words[index] === "push") changes.push(readPush(words.slice(index + 1), segment.expands));
      continue;
    }
    if (program === "gh") {
      let index = 1;
      // `gh -R owner/repo pr merge`, `gh --repo …`.
      while (index < words.length && (words[index] ?? "").startsWith("-")) {
        index += words[index] === "-R" || words[index] === "--repo" ? 2 : 1;
      }
      changes.push(...readGh(words.slice(index), text, segment.expands));
    }
  }
  return changes;
}

/** Every push, merge, and pull-request change the command reads as making. */
export function forgeShellChanges(command: string): ReadonlyArray<ForgeShellChange> {
  return changesIn(command, 0);
}

/**
 * The hard line a command crosses, or `undefined`. A merge and a plain
 * force-push (or a force of any kind onto a branch that is not the thread's
 * own) need the person's approval for that one act; a push that names
 * another thread's branch, or pushes every branch while other threads have
 * some, is never the thread's to make. A target the command hides is not a
 * crossing: Octant cannot see it, and records it instead.
 */
export function forgeShellHardLine(
  changes: ReadonlyArray<ForgeShellChange>,
  threads: {
    /** The thread's own delivery branch, when it has one. */
    readonly ownBranch?: string | undefined;
    /** Branches other threads of the same repository work on. */
    readonly otherThreadBranches: ReadonlyArray<string>;
  },
): ForgeShellHardLine | undefined {
  const others = new Set(
    threads.otherThreadBranches.filter((branch) => branch !== threads.ownBranch),
  );
  for (const change of changes) {
    if (change.kind === "merge") return "merge-not-asked";
    if (change.kind !== "push") continue;
    if (change.branches.some((branch) => others.has(branch))) return "other-thread-branch";
    if (change.allBranches && others.size > 0) return "other-thread-branch";
    if (change.force === "plain") return "force-push-not-asked";
    if (change.force === "with-lease" || change.deletes) {
      const ontoOwn = change.branches.every((branch) => branch === threads.ownBranch);
      if (!ontoOwn || change.allBranches) return "force-push-not-asked";
    }
  }
  return undefined;
}

/** What the agent is told when a command is refused; it names the path that asks the person. */
export function forgeShellHardLineMessage(line: ForgeShellHardLine): string {
  switch (line) {
    case "merge-not-asked":
      return "Octant refused this command: a pull request is merged only when the person asks. Ask them, or use Octant's merge tool, which asks for their approval.";
    case "force-push-not-asked":
      return "Octant refused this command: a plain force-push, or a force or delete on a branch that is not this thread's own, happens only with the person's approval for that one act. Ask them, or use Octant's push tool with force-with-lease on this thread's own branch.";
    case "other-thread-branch":
      return "Octant refused this command: it pushes to a branch another thread works on, which this thread never changes.";
  }
}

export type ForgeShellChangeKind = "push" | "force-push" | "merge" | "pull-request";

/** What a record names: each kind once, in the order first seen, the branches pushed, and whether a target hid. */
export function forgeShellChangeSummary(changes: ReadonlyArray<ForgeShellChange>): {
  readonly kinds: ReadonlyArray<ForgeShellChangeKind>;
  readonly branches: ReadonlyArray<string>;
  readonly unreadable: boolean;
} {
  const kinds: ForgeShellChangeKind[] = [];
  const branches: string[] = [];
  for (const change of changes) {
    const kind: ForgeShellChangeKind =
      change.kind === "push"
        ? change.force !== "none" || change.deletes
          ? "force-push"
          : "push"
        : change.kind;
    if (!kinds.includes(kind)) kinds.push(kind);
    if (change.kind === "push") {
      for (const branch of change.branches) if (!branches.includes(branch)) branches.push(branch);
    }
  }
  return { kinds, branches, unreadable: changes.some((change) => change.unreadable) };
}
