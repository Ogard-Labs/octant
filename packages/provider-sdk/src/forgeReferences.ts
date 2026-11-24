import {
  MAX_THREAD_FORGE_REFERENCES_PER_CALL,
  ThreadForgeReference,
  type ThreadForgeAction,
  type ThreadGithubForgeReference,
} from "@octant/contracts";
import { Schema } from "effect";

/**
 * One finished tool call as an adapter sees it, before anything is reduced or
 * redacted for the normalized event. Nothing here crosses: only the
 * references this module derives from it do.
 */
export interface ForgeToolCall {
  /** The tool's name as the runtime reports it, such as `Bash` or `mcp__github__merge_pull_request`. */
  readonly toolName: string;
  /** The full command a shell tool ran. */
  readonly command?: string;
  /** A structured tool's arguments. */
  readonly input?: unknown;
  /** The call's result text. */
  readonly output?: string;
}

type Kind = ThreadGithubForgeReference["kind"];

const GH_PR_WRITES: Readonly<Record<string, ThreadForgeAction>> = {
  create: "created",
  merge: "merged",
  review: "reviewed",
  comment: "commented",
  edit: "edited",
  ready: "edited",
  close: "closed",
  reopen: "reopened",
};

const GH_ISSUE_WRITES: Readonly<Record<string, ThreadForgeAction>> = {
  create: "created",
  comment: "commented",
  edit: "edited",
  close: "closed",
  reopen: "reopened",
};

const OWNER = String.raw`[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}`;
const REPOSITORY = String.raw`[A-Za-z0-9_.-]{1,100}`;
const GITHUB_URL = new RegExp(
  String.raw`https://github\.com/(${OWNER})/(${REPOSITORY})/(pull|issues)/([1-9][0-9]{0,8})(?![0-9])`,
  "g",
);
const GITHUB_URL_ALONE = new RegExp(
  String.raw`^https://github\.com/${OWNER}/${REPOSITORY}/(pull|issues)/[1-9][0-9]{0,8}/?$`,
);
const isThreadForgeReference = Schema.is(ThreadForgeReference);

/** gh's own success lines: "Merged pull request owner/repo#12", "Closed issue owner/repo#7". */
const GH_SUCCESS_LINE = new RegExp(
  String.raw`\b(pull request|issue) (${OWNER})/(${REPOSITORY})#([1-9][0-9]{0,8})\b`,
  "g",
);
/**
 * gh's success lines that open with the pull request: 'Pull request
 * owner/repo#12 is marked as "ready for review"'. A refusal opens the same way
 * ("Pull request owner/repo#12 is not mergeable"), so the verb must be one of these.
 */
const GH_SUCCESS_STATE_LINE = new RegExp(
  String.raw`\b(Pull request) (${OWNER})/(${REPOSITORY})#([1-9][0-9]{0,8}) (?:is marked as|is converted to|will be) `,
  "g",
);
/** What each of gh's success lines says was done. */
const GH_LINE_ACTIONS: ReadonlyArray<readonly [RegExp, ThreadForgeAction]> = [
  [/\bmerged pull request /i, "merged"],
  [/ will be added to the merge queue/, "merged"],
  [/\bwill be automatically merged /, "edited"],
  [/\bauto-merge disabled for pull request /i, "edited"],
  [/ is (?:marked as|converted to) /, "edited"],
  [/\bclosed (?:pull request|issue) /i, "closed"],
  [/\breopened (?:pull request|issue) /i, "reopened"],
  [/\b(?:approved|reviewed|requested changes to) pull request /i, "reviewed"],
];
const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/;
const LINEAR_URL = /https:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8})\b/g;

interface GithubIdentity {
  readonly kind: Kind;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

function identityKey(identity: {
  readonly kind: string;
  readonly owner?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly identifier?: string;
}): string {
  return (
    identity.identifier ??
    `${identity.kind}:${identity.owner ?? ""}/${identity.repository ?? ""}#${String(identity.number ?? 0)}`.toLowerCase()
  );
}

function githubUrlsIn(text: string): ReadonlyArray<GithubIdentity> {
  const found: GithubIdentity[] = [];
  for (const match of text.matchAll(GITHUB_URL)) {
    const [, owner, repository, segment, number] = match;
    if (owner === undefined || repository === undefined || number === undefined) continue;
    found.push({
      kind: segment === "pull" ? "pull-request" : "issue",
      owner,
      repository,
      number: Number(number),
    });
  }
  return found;
}

function githubSuccessLinesIn(text: string): ReadonlyArray<GithubIdentity> {
  const found: GithubIdentity[] = [];
  const lines = [...text.matchAll(GH_SUCCESS_LINE), ...text.matchAll(GH_SUCCESS_STATE_LINE)];
  for (const [, noun, owner, repository, number] of lines) {
    if (owner === undefined || repository === undefined || number === undefined) continue;
    found.push({
      kind: noun === "issue" ? "issue" : "pull-request",
      owner,
      repository,
      number: Number(number),
    });
  }
  return found;
}

interface ShellCommand {
  readonly words: ReadonlyArray<string>;
  /**
   * Whether the call's exit status says this command succeeded: it is in the
   * call's last `;`-separated list, and that list joins its commands with `&&`
   * alone. After `||`, a pipe or `&` a later command can succeed when this one
   * failed, and an earlier list's exit status is not the call's.
   */
  readonly exitSpeaks: boolean;
}

/** The writes gh's own output says happened, each as "action identity". */
function confirmedWritesIn(output: string): ReadonlySet<string> {
  const confirmed = new Set<string>();
  const confirm = (action: ThreadForgeAction, identity: GithubIdentity) =>
    confirmed.add(`${action} ${identityKey(identity)}`);
  for (const line of output.split("\n")) {
    for (const identity of githubSuccessLinesIn(line)) {
      for (const [says, action] of GH_LINE_ACTIONS) if (says.test(line)) confirm(action, identity);
    }
    for (const identity of githubUrlsIn(line)) {
      confirm("created", identity);
      if (line.includes("#issuecomment-")) confirm("commented", identity);
    }
  }
  return confirmed;
}

/**
 * Whether a command can end the shell while the call still succeeds (`exit`,
 * `exit 0`, `exec other`), so that what follows it may never have run. A
 * failing `exit 1` would have failed the call, and an `exec` that only
 * redirects ends nothing.
 */
function endsTheShellWell(words: ReadonlyArray<string>): boolean {
  const at = words.findIndex((word) => word === "exit" || word === "return" || word === "exec");
  if (at === -1 || !words.slice(0, at).every(runsTheNextWord)) return false;
  const next = words[at + 1] ?? "";
  return words[at] === "exec"
    ? next !== "" && !/^[0-9]*[<>&]/.test(next)
    : !/^[1-9][0-9]*$/.test(next);
}

/**
 * Splits a command line into words, honouring quotes, backslash escapes and
 * comments, and into separate commands at `&&`, `||`, `;`, `|`, `&` and line
 * breaks. It is not a shell: it only has to find `gh` invocations and their
 * arguments, and which of them the exit status speaks for.
 */
function shellCommands(command: string): ReadonlyArray<ShellCommand> {
  const lists: Array<{ readonly commands: string[][]; andOnly: boolean }> = [];
  let list: { readonly commands: string[][]; andOnly: boolean } = { commands: [], andOnly: true };
  let words: string[] = [];
  // Whether `&&`, `||` or `|` still waits for the command it joins: a line
  // break after one of them does not end the list.
  let joins = false;
  let word = "";
  let quote: '"' | "'" | undefined;
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) {
      list.commands.push(words);
      joins = false;
    }
    words = [];
  };
  const endList = () => {
    endCommand();
    joins = false;
    if (list.commands.length > 0) lists.push(list);
    list = { commands: [], andOnly: true };
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    const next = command.charAt(index + 1);
    if (character === "\\" && quote !== "'") {
      // A backslash before a line break continues the line; before anything
      // else it makes that character part of the word.
      index += 1;
      if (next !== "\n") {
        word += next;
        inWord = true;
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inWord = true;
      continue;
    }
    if (character === "#" && !inWord) {
      while (index + 1 < command.length && command.charAt(index + 1) !== "\n") index += 1;
      continue;
    }
    if (character === "&" && next === "&") {
      endCommand();
      joins = true;
      index += 1;
      continue;
    }
    // `2>&1` and `&>file` redirect; they do not end the command.
    if (character === "&" && (next === ">" || /[<>]$/.test(word))) {
      word += character;
      inWord = true;
      continue;
    }
    if (character === "|" || character === "&") {
      endCommand();
      joins = character === "|";
      if (character === "|" && (next === "|" || next === "&")) index += 1;
      list.andOnly = false;
      continue;
    }
    if (character === "\n" && joins && words.length === 0 && !inWord) continue;
    if (character === "\n" || character === ";") {
      endList();
      continue;
    }
    if (character === " " || character === "\t") {
      endWord();
      continue;
    }
    word += character;
    inWord = true;
  }
  endList();
  const commands: ShellCommand[] = [];
  let mayHaveEnded = false;
  for (const [index, each] of lists.entries()) {
    for (const found of each.commands) {
      commands.push({
        words: found,
        exitSpeaks: each.andOnly && index === lists.length - 1 && !mayHaveEnded,
      });
      mayHaveEnded ||= endsTheShellWell(found);
    }
  }
  return commands;
}

interface GhInvocation {
  readonly kind: Kind;
  /** Undefined for a read (`view`, `list`, `checks`, `diff`, …). */
  readonly action: ThreadForgeAction | undefined;
  /** A merge with `--auto` (or ending one): GitHub merges it, now or later. */
  readonly leavesMerge: boolean;
  /** The identity the command names itself, when it names one fully. */
  readonly named: GithubIdentity | undefined;
  /** The number the command names without a repository. */
  readonly number: number | undefined;
  /** Whether the call's exit status says this command succeeded. */
  readonly exitSpeaks: boolean;
}

/**
 * `gh pr|issue` options whose value is text or another ref, never the target:
 * a body or title can cite any pull request, a base or head names a branch,
 * and a parent or duplicate is another issue's number.
 */
const GH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--body",
  "-b",
  "--body-file",
  "-F",
  "--title",
  "-t",
  "--base",
  "-B",
  "--head",
  "-H",
  "--label",
  "-l",
  "--add-label",
  "--remove-label",
  "--assignee",
  "-a",
  "--add-assignee",
  "--remove-assignee",
  "--reviewer",
  "-r",
  "--add-reviewer",
  "--remove-reviewer",
  "--milestone",
  "-m",
  "--project",
  "-p",
  "--add-project",
  "--remove-project",
  "--template",
  "-T",
  "--subject",
  "--match-head-commit",
  "--author-email",
  "-A",
  "--attach",
  "--recover",
  "--type",
  "--parent",
  "--duplicate-of",
  "--blocked-by",
  "--blocking",
  "--add-blocked-by",
  "--add-blocking",
  "--add-sub-issue",
  "--remove-blocked-by",
  "--remove-blocking",
  "--remove-sub-issue",
  "--comment",
  "-c",
  "--reason",
  "--json",
  "--jq",
  "-q",
]);

/** Flags of one subcommand that take no value, though others' of the same name do. */
const GH_SWITCHES: Readonly<Record<string, ReadonlySet<string>>> = {
  "pr review": new Set(["-a", "-c", "--comment", "-r"]),
  "pr merge": new Set(["-m", "-r"]),
};

/** Words that run the command after them, with their own options and durations. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  "command",
  "do",
  "else",
  "env",
  "exec",
  "nohup",
  "sudo",
  "then",
  "time",
  "timeout",
]);

/**
 * Whether a word before `gh` leaves it the command that runs: an environment
 * assignment, or a wrapper with its options. Anything else (`echo gh pr merge
 * 12`, or a `!` that turns failure into success) makes `gh` text or untold.
 */
function runsTheNextWord(word: string): boolean {
  return (
    COMMAND_PREFIXES.has(word) ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ||
    word.startsWith("-") ||
    /^[0-9.]+[smhd]?$/.test(word)
  );
}

function ghInvocation({ words, exitSpeaks }: ShellCommand): GhInvocation | undefined {
  const at = words.findIndex((candidate) => candidate === "gh" || candidate.endsWith("/gh"));
  if (at === -1 || !words.slice(0, at).every(runsTheNextWord)) return undefined;
  const noun = words[at + 1];
  const verb = words[at + 2];
  if ((noun !== "pr" && noun !== "issue") || verb === undefined) return undefined;
  const kind: Kind = noun === "pr" ? "pull-request" : "issue";
  const switches = GH_SWITCHES[`${noun} ${verb}`];
  const rest = words.slice(at + 3);
  // `--auto` leaves the merge to GitHub until the requirements are met.
  const leavesMerge =
    noun === "pr" && verb === "merge" && rest.some((word) => /^--(disable-)?auto$/.test(word));
  const action = leavesMerge ? "edited" : (noun === "pr" ? GH_PR_WRITES : GH_ISSUE_WRITES)[verb];
  let repository: { readonly owner: string; readonly repository: string } | undefined;
  let number: number | undefined;
  let named: GithubIdentity | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? "";
    if (GH_VALUE_FLAGS.has(argument) && switches?.has(argument) !== true) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-") && argument.includes("=") && !argument.startsWith("--repo=")) {
      continue;
    }
    const repoValue =
      argument === "--repo" || argument === "-R"
        ? rest[index + 1]
        : argument.startsWith("--repo=")
          ? argument.slice("--repo=".length)
          : undefined;
    if (repoValue !== undefined) {
      // `[HOST/]OWNER/REPO`; only github.com identities are exact here.
      const parts = repoValue.split("/");
      const owner = parts.at(-2);
      const name = parts.at(-1);
      if (
        owner !== undefined &&
        name !== undefined &&
        (parts.length === 2 || (parts.length === 3 && parts[0] === "github.com")) &&
        new RegExp(`^${OWNER}$`).test(owner) &&
        new RegExp(`^${REPOSITORY}$`).test(name)
      ) {
        repository = { owner, repository: name };
      }
      continue;
    }
    if (named === undefined) {
      // The target is an argument that is wholly an address, never one cited
      // inside other text.
      const url = githubUrlsIn(argument)[0];
      if (url !== undefined && url.kind === kind && GITHUB_URL_ALONE.test(argument)) named = url;
    }
    if (number === undefined && /^#?[1-9][0-9]{0,8}$/.test(argument)) {
      number = Number(argument.replace("#", ""));
    }
  }
  if (named === undefined && repository !== undefined && number !== undefined) {
    named = { kind, ...repository, number };
  }
  return { kind, action, leavesMerge, named, number, exitSpeaks };
}

function fromShell(
  command: string,
  output: string | undefined,
): ReadonlyArray<ThreadForgeReference> {
  const invocations = shellCommands(command)
    .map(ghInvocation)
    .filter((invocation): invocation is GhInvocation => invocation !== undefined);
  const found = [...githubUrlsIn(output ?? ""), ...githubSuccessLinesIn(output ?? "")];
  // What the output proves was written: gh's success line for that very write
  // ("Closed issue acme/app#7" proves no reopen), the new thing's address for a
  // create, and its own anchor for a comment. A read in a fallback prints
  // addresses too, so a bare address proves nothing else.
  const confirmed = confirmedWritesIn(output ?? "");
  const references: ThreadForgeReference[] = [];
  for (const invocation of invocations) {
    if (invocation.action === undefined) continue;
    const sameKind = invocations.filter((candidate) => candidate.kind === invocation.kind);
    let identity = invocation.named;
    if (identity === undefined && invocation.number !== undefined) {
      // A number without a repository: the output names the repository, and
      // only an exact match on kind and number completes it.
      const matches = found.filter(
        (candidate) => candidate.kind === invocation.kind && candidate.number === invocation.number,
      );
      const repositories = new Set(matches.map((candidate) => identityKey(candidate)));
      if (repositories.size === 1) identity = matches[0];
    }
    if (identity === undefined && invocation.number === undefined && sameKind.length === 1) {
      // A command that names no pull request or issue (`gh pr create`, or a
      // merge of the current branch's): the output's one identity of that
      // kind is the one it wrote. Several, or a read of the same kind in the
      // same command, leave it unknown rather than guessed.
      const ofKind = new Map(
        found
          .filter((candidate) => candidate.kind === invocation.kind)
          .map((candidate) => [identityKey(candidate), candidate] as const),
      );
      if (ofKind.size === 1) identity = [...ofKind.values()][0];
    }
    if (identity === undefined) continue;
    // When the call's exit status does not speak for this command (it ran
    // before a `||` fallback, say), only its own output confirms the write.
    // gh merges at once when nothing is left to wait for, and then says so.
    const mergedAtOnce = invocation.leavesMerge && confirmed.has(`merged ${identityKey(identity)}`);
    const action = mergedAtOnce ? "merged" : invocation.action;
    if (!invocation.exitSpeaks && !confirmed.has(`${action} ${identityKey(identity)}`)) continue;
    const state =
      identity.kind === "issue" && action === "closed"
        ? "closed"
        : identity.kind === "issue" && action === "reopened"
          ? "open"
          : undefined;
    references.push({
      forge: "github",
      kind: identity.kind,
      action,
      owner: identity.owner,
      repository: identity.repository,
      number: identity.number,
      ...(state === undefined ? {} : { state }),
    });
  }
  return references;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Every object in a parsed JSON value, depth first, bounded. */
function objectsIn(value: unknown, limit = 200): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const found: Array<Readonly<Record<string, unknown>>> = [];
  const visit = (current: unknown, depth: number) => {
    if (found.length >= limit || depth > 6) return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const object = record(current);
    if (object === undefined) return;
    found.push(object);
    for (const child of Object.values(object)) visit(child, depth + 1);
  };
  visit(value, 0);
  return found;
}

const encoder = new TextEncoder();

/**
 * A result's text, cut to at most `maximumBytes` of UTF-8 at a character
 * boundary. The journal bounds these by encoded bytes and refuses the whole
 * event past them, so a long title in a multibyte script must not cross.
 */
function text(value: unknown, maximumBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (encoder.encode(trimmed).byteLength <= maximumBytes) return trimmed;
  let bounded = "";
  let bytes = 0;
  for (const character of trimmed) {
    bytes += encoder.encode(character).byteLength;
    if (bytes > maximumBytes) break;
    bounded += character;
  }
  return bounded.trimEnd();
}

/** The part of a structured tool's name after its server prefix, lower-cased. */
function operationName(toolName: string): string {
  const lower = toolName.toLowerCase();
  const separator = lower.lastIndexOf("__");
  return separator === -1 ? lower : lower.slice(separator + 2);
}

const READ_WORDS = /(^|_)(get|list|search|read|fetch|view|find)(_|$)/;

function githubToolAction(
  operation: string,
  input: Readonly<Record<string, unknown>> | undefined,
): ThreadForgeAction | undefined {
  if (READ_WORDS.test(operation)) return undefined;
  if (!/pull_request|issue|review|comment/.test(operation)) return undefined;
  if (operation.includes("merge")) return "merged";
  if (operation.includes("review")) return "reviewed";
  if (operation.includes("comment")) return "commented";
  const method = typeof input?.method === "string" ? input.method.toLowerCase() : undefined;
  if (input?.state === "closed") return "closed";
  if (input?.state === "open" && method === "update") return "reopened";
  if (operation.startsWith("create") || method === "create") return "created";
  if (/update|edit|write/.test(operation)) return "edited";
  return undefined;
}

function numberField(
  input: Readonly<Record<string, unknown>> | undefined,
  names: ReadonlyArray<string>,
): number | undefined {
  for (const name of names) {
    const value = input?.[name];
    const number =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isInteger(number) && number > 0 && number < 1_000_000_000) return number;
  }
  return undefined;
}

/** A pull request or issue a structured tool's result named, with what it said of it. */
interface ResultIdentity {
  readonly identity: GithubIdentity;
  readonly title?: string;
  readonly state?: string;
}

function fromGithubTool(call: ForgeToolCall): ReadonlyArray<ThreadForgeReference> {
  const input = record(call.input);
  const operation = operationName(call.toolName);
  const action = githubToolAction(operation, input);
  if (action === undefined) return [];
  const parsed = parseJson(call.output);
  const objects = objectsIn(parsed);
  // The result's own address is the most exact identity; a create has no
  // number until the result names it.
  const fromResult = objects
    .map((object): ResultIdentity | undefined => {
      const url = text(object.html_url, 2_048) ?? text(object.url, 2_048);
      const identity = url === undefined ? undefined : githubUrlsIn(url)[0];
      if (identity === undefined) return undefined;
      const merged = object.merged === true || text(object.merged_at, 64) !== undefined;
      const state = merged ? "merged" : text(object.state, 64);
      const title = text(object.title, 256);
      return {
        identity,
        ...(title === undefined ? {} : { title }),
        ...(state === undefined ? {} : { state }),
      };
    })
    .filter((entry) => entry !== undefined);
  const first: ResultIdentity | undefined =
    fromResult[0] ??
    (() => {
      const urls = githubUrlsIn(call.output ?? "");
      return urls.length === 1 && urls[0] !== undefined ? { identity: urls[0] } : undefined;
    })();
  const owner = text(input?.owner, 39);
  const repository = text(input?.repo ?? input?.repository, 100);
  const number = numberField(input, [
    "pullNumber",
    "pull_number",
    "issue_number",
    "issueNumber",
    "number",
  ]);
  const kind: Kind =
    first?.identity.kind ?? (/pull_request|review/.test(operation) ? "pull-request" : "issue");
  const identity =
    first?.identity ??
    (owner !== undefined && repository !== undefined && number !== undefined
      ? { kind, owner, repository, number }
      : undefined);
  if (identity === undefined) return [];
  if (
    !new RegExp(`^${OWNER}$`).test(identity.owner) ||
    !new RegExp(`^${REPOSITORY}$`).test(identity.repository)
  ) {
    return [];
  }
  return [
    {
      forge: "github",
      kind: identity.kind,
      action,
      owner: identity.owner,
      repository: identity.repository,
      number: identity.number,
      ...(first?.title === undefined ? {} : { title: first.title }),
      ...(first?.state === undefined ? {} : { state: first.state }),
    },
  ];
}

function linearToolAction(
  operation: string,
  input: Readonly<Record<string, unknown>> | undefined,
): ThreadForgeAction | undefined {
  if (READ_WORDS.test(operation)) return undefined;
  if (operation.includes("comment")) return "commented";
  if (!operation.includes("issue")) return undefined;
  if (operation.startsWith("create")) return "created";
  if (operation.startsWith("save")) return input?.id === undefined ? "created" : "edited";
  if (/update|edit/.test(operation)) return "edited";
  return undefined;
}

function linearState(object: Readonly<Record<string, unknown>>): string | undefined {
  const direct = text(object.status, 64) ?? text(object.state, 64);
  if (direct !== undefined) return direct;
  const nested = record(object.status) ?? record(object.state);
  return text(nested?.name, 64);
}

/** The result's address for this issue, only when it is the issue's own linear.app page. */
function linearIssueUrl(url: string | undefined, identifier: string): string | undefined {
  if (url === undefined) return undefined;
  const match =
    /^https:\/\/linear\.app\/[A-Za-z0-9_.-]+\/issue\/([A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8})(?:\/[A-Za-z0-9_.-]*)?$/.exec(
      url,
    );
  return match?.[1] === identifier ? url : undefined;
}

function fromLinearTool(call: ForgeToolCall): ReadonlyArray<ThreadForgeReference> {
  const input = record(call.input);
  const action = linearToolAction(operationName(call.toolName), input);
  if (action === undefined) return [];
  const objects = objectsIn(parseJson(call.output));
  for (const object of objects) {
    // Linear's own server gives the key as `id`; others give it as `identifier`.
    const identifier = [object.identifier, object.id]
      .map((value) => text(value, 32))
      .find((value) => value !== undefined && LINEAR_IDENTIFIER.test(value));
    if (identifier === undefined) continue;
    const title = text(object.title, 256);
    const state = linearState(object);
    const url = linearIssueUrl(text(object.url, 512), identifier);
    return [
      {
        forge: "linear",
        kind: "issue",
        action,
        identifier,
        ...(url === undefined ? {} : { url }),
        ...(title === undefined ? {} : { title }),
        ...(state === undefined ? {} : { state }),
      },
    ];
  }
  const fromUrl = [...(call.output ?? "").matchAll(LINEAR_URL)].map((match) => match[1]);
  const fromInput = [input?.issueId, input?.issue, input?.id]
    .map((value) => text(value, 32))
    .filter((value) => value !== undefined && LINEAR_IDENTIFIER.test(value));
  const identifiers = new Set([...fromUrl, ...fromInput].filter((value) => value !== undefined));
  if (identifiers.size !== 1) return [];
  const identifier = [...identifiers][0];
  return identifier === undefined ? [] : [{ forge: "linear", kind: "issue", action, identifier }];
}

/**
 * The pull requests and issues one finished tool call wrote to, by exact
 * identity, for an adapter to put on its `tool-success` event. A read never
 * counts, a title or branch name never stands in for an identity, and an
 * identity the call does not pin down exactly is left out rather than
 * guessed. Returns undefined when the call touched none.
 */
export function forgeReferencesFromToolCall(
  call: ForgeToolCall,
): ReadonlyArray<ThreadForgeReference> | undefined {
  const lower = call.toolName.toLowerCase();
  const found =
    call.command !== undefined
      ? fromShell(call.command, call.output)
      : lower.includes("github")
        ? fromGithubTool(call)
        : lower.includes("linear")
          ? fromLinearTool(call)
          : [];
  const unique = new Map<string, ThreadForgeReference>();
  for (const reference of found) {
    // One reference the journal refuses would lose the whole call's event.
    if (!isThreadForgeReference(reference)) continue;
    const key = identityKey(reference);
    const earlier = unique.get(key);
    // One call can write to the same thing twice (comment, then close). The
    // last write stands, with the state and title it did not report itself.
    const state = reference.state ?? earlier?.state;
    const title = reference.title ?? earlier?.title;
    unique.set(key, {
      ...reference,
      ...(title === undefined ? {} : { title }),
      ...(state === undefined ? {} : { state }),
    });
  }
  const references = [...unique.values()].slice(0, MAX_THREAD_FORGE_REFERENCES_PER_CALL);
  return references.length === 0 ? undefined : references;
}
