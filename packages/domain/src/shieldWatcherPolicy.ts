import { SHIELD_WATCHER_LABELS, type ShieldWatcherLabel } from "@octant/contracts";
import { commandPathWords } from "./secretGuardPolicy";

/**
 * Octant Shield's Watcher, the deterministic part: detectors that label
 * injection-shaped outside content as it enters a thread (docs/architecture.md,
 * Octant Shield). Pure: the server runs them on each tool result and journals
 * the labels.
 *
 * The Watcher can only raise. A label marks the thread, tags the tool row,
 * and tells the Judge which kinds it saw; no label, and no missing label,
 * ever allows a call. A detector that misses leaves the thread exactly as
 * guarded as before, so the detectors favour plain patterns over cleverness,
 * and every pattern is linear: no nested quantifier, and every window bounded.
 */

/**
 * The source label a Watcher label is journaled under, beside the tool's own.
 * The mark's projection keeps it, so the Judge is still told after a restart,
 * and a person's clear forgets it with the rest of the mark.
 */
export const SHIELD_WATCHER_SOURCE_PREFIX = "shield-watcher-";

/** Each label in words, after "Outside content ·" on a tool row and in a source list. */
export const SHIELD_WATCHER_LABEL_WORDS: Readonly<Record<ShieldWatcherLabel, string>> = {
  "agent-instructions": "instructions aimed at the agent",
  "hidden-text": "hidden text",
  "encoded-text": "encoded text",
  "exfiltration-request": "a request to send secrets out",
  "fake-authority": "a false claim of authority",
  "secret-path-read": "a read of a protected secret file",
  "secret-env-print": "a printed secret-holding environment variable",
};

/** The Watcher label a journaled source label names, if it names one. */
export function shieldWatcherLabelOfSource(sourceLabel: string): ShieldWatcherLabel | undefined {
  if (!sourceLabel.startsWith(SHIELD_WATCHER_SOURCE_PREFIX)) return undefined;
  const label = sourceLabel.slice(SHIELD_WATCHER_SOURCE_PREFIX.length);
  return SHIELD_WATCHER_LABELS.find((candidate) => candidate === label);
}

/** Most of a result's text the Watcher reads: the head and the tail of anything longer. */
export const MAX_WATCHED_TEXT_LENGTH = 512 * 1024;
/** Most string values gathered from one structured result. */
const MAX_WATCHED_STRINGS = 4_096;
const MAX_WATCHED_DEPTH = 16;
/** A sentence longer than this is read in windows of this size. */
const SENTENCE_WINDOW = 600;

const AGENT_INSTRUCTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:ignore|disregard|override|forget|skip)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+|these\s+)?(?:previous|prior|above|earlier|preceding|original|system|existing)\s+(?:instructions?|prompts?|messages?|directions?|rules?|guidelines?|context)\b/i,
  /\bforget\s+(?:everything|all)\s+(?:you\s+)?(?:were|have\s+been)\s+told\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the|in|my)\s/i,
  /\bnew\s+(?:system\s+)?instructions?\s*:/i,
  /\b(?:ai|llm|assistant|agent|model|chatbot|bot)s?\s+(?:that\s+(?:is|are)\s+)?(?:reading|processing|parsing|summari[sz]ing|browsing|crawling)\s+this\b/i,
  /\b(?:note|message|attention|instructions?|reminder)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llm|assistant|coding\s+agent|agent|language\s+model|model)s?\b/i,
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|alert|notify|mention\s+(?:this\s+|it\s+)?to)\s+the\s+(?:user|person|human|operator)\b/i,
  /\bwithout\s+(?:telling|informing|asking|alerting|notifying)\s+the\s+(?:user|person|human|operator)\b/i,
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/i,
  /\[\/?INST\]|<<\/?SYS>>/,
  /<\/?(?:system|system[-_]prompt|instructions?)>/i,
];

const FAKE_AUTHORITY_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:message|notice|instructions?|directive|update|alert|order)\s+from\s+(?:the\s+|your\s+)?(?:system|system\s+administrator|administrator|admin|developers?|security\s+team|it\s+department|operators?)\b/i,
  /(?:^|\n)\W{0,8}(?:system|admin|administrator|developer|security)\s+(?:override|message|notice|instruction|prompt|alert)\s*:/i,
  /\bthe\s+(?:user|owner|person|human|operator)\s+(?:has\s+)?(?:already\s+)?(?:approved|authori[sz]ed|granted\s+(?:you\s+)?permission|consented|pre-?approved)\b/i,
  /\bthe\s+(?:user|owner|person|human|operator)\s+(?:wants|asked|instructed|told)\s+you\s+to\b/i,
  /\b(?:authori[sz]ed|approved|sanctioned)\s+by\s+(?:the\s+)?(?:user|owner|administrator|admin|security\s+team|system)\b/i,
  /\b(?:priority|emergency|security)\s+override\b/i,
  /\b(?:these|this|the\s+following)\s+instructions?\s+(?:take|takes|have|has)\s+(?:priority|precedence)\b/i,
];

const SECRET_NOUN =
  /\b(?:api[\s_-]?keys?|access[\s_-]?tokens?|auth(?:entication)?[\s_-]?tokens?|bearer\s+tokens?|session\s+(?:tokens?|cookies?)|secrets?|passwords?|passphrases?|credentials?|private\s+keys?|ssh\s+keys?|signing\s+keys?|cookies|environment\s+variables|env\s+vars?|keychain)\b|\.env\b|\bid_(?:rsa|ed25519|ecdsa)\b|\baws_secret_access_key\b|\.aws\/credentials|\.ssh\//i;
const EGRESS_VERB =
  /\b(?:send|post|upload|exfiltrat\w*|forward|transmit|e-?mail|leak|submit|report|paste|append|include|encode)\b/i;
const DESTINATION =
  /\bto\s+(?:https?:\/\/|[\w.+-]+@[\w-]+\.[\w.-]+|(?:this|that|the\s+following|my|our|a|an)\s+(?:url|address|link|endpoint|server|webhook|email|site|domain|form|gist|pastebin|channel))|\bhttps?:\/\/\S+[?&][\w-]{1,32}=|\b(?:curl|wget)\b|\bin\s+(?:the|a)\s+(?:url|query\s+string|request|image\s+link)\b/i;
/** A Markdown image whose address carries a placeholder: a beacon that leaks what fills it. */
const IMAGE_BEACON =
  /!\[[^\]\n]{0,200}\]\(\s*https?:\/\/[^)\s]{1,500}[?&][^)\s=]{1,64}=(?:\{|\$|<|%7[bB]|\[)/;

/** Invisible characters a person cannot see but a model reads. */
const TAG_CHARACTER = /[\u{E0000}-\u{E007F}]/u;
const BIDI_OVERRIDE = /[‪-‮⁦-⁩]/;
// The joiner (U+200D) is left out: emoji sequences use it in plain text.
const ZERO_WIDTH = /[​‌⁠᠎﻿]/g;
const ZERO_WIDTH_THRESHOLD = 8;
const HIDING_STYLE =
  /\b(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*[;"'}]|opacity\s*:\s*0(?:\.0+)?\s*[;"'}])|\baria-hidden\s*=\s*["']true["']|\bhidden\s*>/i;

const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9_-]{40,}/g;
const DECODE_THEN_ACT =
  /\b(?:decode|base64\s*-d|unescape|rot13|reverse)\b[^.\n]{0,60}\b(?:and|then)\s+(?:run|execute|follow|obey|apply|do)\b/i;

/**
 * The labels a piece of outside content earns, in the contract's order. The
 * text is what the agent is about to read: a tool result, a fetched page, a
 * file, or a command's output.
 */
export function watchOutsideContent(text: string): ReadonlyArray<ShieldWatcherLabel> {
  const watched = boundedText(text);
  if (watched.length === 0) return [];
  const found = new Set<ShieldWatcherLabel>();
  const instructions = AGENT_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(watched));
  if (instructions) found.add("agent-instructions");
  if (hidesText(watched)) found.add("hidden-text");
  if (encodesText(watched)) found.add("encoded-text");
  if (asksForExfiltration(watched)) found.add("exfiltration-request");
  if (FAKE_AUTHORITY_PATTERNS.some((pattern) => pattern.test(watched))) {
    found.add("fake-authority");
  }
  return SHIELD_WATCHER_LABELS.filter((label) => found.has(label));
}

/**
 * The text of a tool result as the model will read it: every string value of
 * a structured result, one per line, or the value itself when it is text.
 * Keys are left out; a tool's own field names are not outside content.
 */
export function watchedTextOf(result: unknown): string {
  if (typeof result === "string") return result;
  const parts: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (parts.length >= MAX_WATCHED_STRINGS || depth > MAX_WATCHED_DEPTH) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(result, 0);
  return parts.join("\n");
}

/**
 * Whether a call names a path the secret guard protects: in a path field, or
 * as a word of its shell `command`. The guard's list is the caller's:
 * `protectedSecretPath` answers for one path as the agent wrote it, and
 * absent, nothing is flagged. An attempt counts as much as a read, since the
 * flag is for the person to see what the agent reached for.
 */
export function callReadsProtectedSecret(
  args: unknown,
  protectedSecretPath: ((path: string) => boolean) | undefined,
): boolean {
  if (protectedSecretPath === undefined) return false;
  return pathsOf(args).some((path) => protectedSecretPath(path));
}

/**
 * Whether a shell call printed an environment variable whose name says it
 * holds a secret: its `command` hands one to a printer (`echo $GITHUB_TOKEN`,
 * `printenv NPM_TOKEN`), or its output lists one with a value (`env`,
 * `export -p`). Only a call with a `command` is read; a file tool's result is
 * the file, which the secret guard's list covers.
 *
 * The name decides, not the value, so a token in an unusual format is still
 * seen. A variable handed to another program (`curl -H "... $TOKEN"`) is a
 * use, not a print, and is the Judge's to weigh.
 */
export function callPrintsSecretEnvironment(args: unknown, output: string): boolean {
  if (typeof args !== "object" || args === null) return false;
  const command = (args as Readonly<Record<string, unknown>>)["command"];
  if (typeof command !== "string") return false;
  return commandPrintsSecretVariable(command) || outputListsSecretVariable(output);
}

/**
 * A name that holds a secret: one of its underscore-separated words is a
 * secret noun. A name ending in a word that says where the secret lives
 * (`_FILE`, `_PATH`, `_SOCK`) or which one it is (`_ID`) holds no secret
 * itself, so `SSH_AUTH_SOCK` and `AWS_ACCESS_KEY_ID` print nothing worth a flag.
 */
export function isSecretHoldingVariable(name: string): boolean {
  const words = name.toUpperCase().split("_");
  const last = words.at(-1);
  if (last === undefined || NOT_A_SECRET_SUFFIX.has(last)) return false;
  return words.some(
    (word, index) =>
      SECRET_NAME_WORDS.has(word) ||
      // A test runner's `PASS=12` and an `AUTH=on` switch say nothing secret;
      // `DB_PASS` and `GITHUB_AUTH` do.
      (index > 0 && QUALIFIED_SECRET_NAME_WORDS.has(word)) ||
      (index > 0 && SECRET_NAME_PAIRS.has(`${words[index - 1]}_${word}`)),
  );
}

const SECRET_NAME_WORDS: ReadonlySet<string> = new Set([
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "APIKEY",
  "CREDENTIAL",
  "CREDENTIALS",
]);
const QUALIFIED_SECRET_NAME_WORDS: ReadonlySet<string> = new Set(["PASS", "AUTH"]);
const SECRET_NAME_PAIRS: ReadonlySet<string> = new Set([
  "API_KEY",
  "ACCESS_KEY",
  "PRIVATE_KEY",
  "SESSION_KEY",
  "SIGNING_KEY",
]);
const NOT_A_SECRET_SUFFIX: ReadonlySet<string> = new Set([
  "ID",
  "FILE",
  "PATH",
  "DIR",
  "SOCK",
  "SOCKET",
  "URL",
  "HOST",
  "USER",
  "USERNAME",
  "REGION",
  "METHOD",
  "TYPE",
  "MODE",
  "ENDPOINT",
  "LENGTH",
  "ENABLED",
  "DISABLED",
]);

/** Programs that print their arguments. */
const PRINTERS: ReadonlySet<string> = new Set(["echo", "printf", "print"]);
/** Words that run the program after them, or open a compound command around it. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  "sudo",
  "command",
  "builtin",
  "exec",
  "time",
  "nohup",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "!",
  "{",
]);
/** `sh -c '…'` and its kin: the quoted body is a command line of its own. */
const SHELL_BODY =
  /(?:^|[\s;&|(])(?:sh|bash|zsh|dash)[ \t]+(?:-[A-Za-z]+[ \t]+){0,4}-[A-Za-z]*c[ \t]+(?:'([^']*)'|"([^"]*)")/g;
const MAX_SHELL_DEPTH = 2;
const MAX_COMMAND_LENGTH = 64 * 1024;
const MAX_SIMPLE_COMMANDS = 256;
const VARIABLE_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `NAME=value` as `env`, `printenv`, `export -p`, and `declare -x` list it. */
const LISTED_VARIABLE =
  /^[ \t]*(?:export[ \t]+|declare[ \t]+-[a-zA-Z]+[ \t]+|typeset[ \t]+-[a-zA-Z]+[ \t]+)?([A-Za-z_][A-Za-z0-9_]{0,255})=(.*)$/gm;

function commandPrintsSecretVariable(command: string, depth = 0): boolean {
  const bounded = command.slice(0, MAX_COMMAND_LENGTH);
  if (depth < MAX_SHELL_DEPTH) {
    for (const match of bounded.matchAll(SHELL_BODY)) {
      if (commandPrintsSecretVariable(match[1] ?? match[2] ?? "", depth + 1)) return true;
    }
  }
  const expanding = withoutLiteralDollars(bounded);
  const simpleCommands = expanding.split(/[;&|\n()]+|`/).slice(0, MAX_SIMPLE_COMMANDS);
  return simpleCommands.some((simple) => {
    const words = simple
      .trim()
      .split(/[ \t]+/)
      .filter((word) => word.length > 0);
    let start = 0;
    while (start < words.length) {
      const word = words[start] ?? "";
      if (!COMMAND_PREFIXES.has(word) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) break;
      start += 1;
    }
    const program = (words[start] ?? "").replace(/["']/g, "").split("/").at(-1) ?? "";
    const rest = words.slice(start + 1);
    if (PRINTERS.has(program)) {
      return rest.some((word) =>
        [...word.matchAll(VARIABLE_REFERENCE)].some((match) =>
          isSecretHoldingVariable(match[1] ?? ""),
        ),
      );
    }
    if (program === "printenv") {
      return rest.some((word) => {
        const name = word.replace(/["']/g, "");
        return VARIABLE_NAME.test(name) && isSecretHoldingVariable(name);
      });
    }
    return false;
  });
}

/**
 * The command with every `$` that expands nothing neutralised: inside single
 * quotes (`echo '$TOKEN'` prints the name) and after a backslash outside them
 * (`echo \\$TOKEN`, also inside double quotes). The words themselves stay, so
 * `printenv 'NPM_TOKEN'` still names its variable. A single quote inside double
 * quotes is an ordinary character, so `echo "a='$TOKEN'"` still expands.
 */
function withoutLiteralDollars(command: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quote === "'") {
      if (character === "'") quote = undefined;
      result += character === "$" ? "_" : character;
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1] ?? "";
      result += next === "$" ? "\\_" : character + next;
      index += 1;
      continue;
    }
    if (character === '"') quote = quote === '"' ? undefined : '"';
    else if (character === "'" && quote === undefined) quote = "'";
    result += character;
  }
  return result;
}

function outputListsSecretVariable(output: string): boolean {
  for (const match of boundedText(output).matchAll(LISTED_VARIABLE)) {
    const value = (match[2] ?? "").replace(/^["']|["']$/g, "").trim();
    if (value.length > 0 && isSecretHoldingVariable(match[1] ?? "")) return true;
  }
  return false;
}

const PATH_FIELDS = ["path", "paths", "file", "files", "filePath", "file_path", "filename"];

function pathsOf(args: unknown): ReadonlyArray<string> {
  if (typeof args !== "object" || args === null) return [];
  const record = args as Readonly<Record<string, unknown>>;
  const fields = PATH_FIELDS.flatMap((field) => {
    const value = record[field];
    if (typeof value === "string") return [value];
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === "string");
    return [];
  });
  const command = record["command"];
  return typeof command === "string" ? [...fields, ...commandPathWords(command)] : fields;
}

function boundedText(text: string): string {
  if (text.length <= MAX_WATCHED_TEXT_LENGTH) return text;
  const half = MAX_WATCHED_TEXT_LENGTH / 2;
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
}

function hidesText(text: string): boolean {
  if (TAG_CHARACTER.test(text) || BIDI_OVERRIDE.test(text)) return true;
  let zeroWidth = 0;
  for (const match of text.matchAll(ZERO_WIDTH)) {
    // A byte-order mark at the very start is how many files begin.
    if (match[0] === "﻿" && match.index === 0) continue;
    zeroWidth += 1;
    if (zeroWidth >= ZERO_WIDTH_THRESHOLD) return true;
  }
  // Instructions inside an HTML comment or a hidden element are meant for a
  // reader that sees the source, which a person viewing the page does not.
  for (const body of htmlComments(text)) {
    if (AGENT_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(body))) return true;
  }
  return (
    HIDING_STYLE.test(text) && AGENT_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function htmlComments(text: string): ReadonlyArray<string> {
  const bodies: string[] = [];
  let from = 0;
  while (bodies.length < 256) {
    const start = text.indexOf("<!--", from);
    if (start === -1) break;
    const end = text.indexOf("-->", start + 4);
    if (end === -1) break;
    bodies.push(text.slice(start + 4, end));
    from = end + 3;
  }
  return bodies;
}

function encodesText(text: string): boolean {
  if (DECODE_THEN_ACT.test(text)) return true;
  let runs = 0;
  for (const match of text.matchAll(BASE64_RUN)) {
    runs += 1;
    if (runs > 256) break;
    const decoded = decodedText(match[0]);
    if (decoded !== undefined) return true;
  }
  return false;
}

/**
 * The run's decoding when it reads as prose: mostly printable ASCII with
 * spaces between words. Hashes, keys, images, and other binary payloads
 * decode to bytes, not sentences, so they are left alone.
 */
function decodedText(run: string): string | undefined {
  // Padding is trimmed by scanning, not by a `=+$` pattern, which backtracks
  // quadratically on a long run of `=`.
  let end = run.length;
  while (end > 0 && run.charCodeAt(end - 1) === 0x3d) end -= 1;
  const body = run.slice(0, end).replace(/-/g, "+").replace(/_/g, "/");
  if (body.length % 4 === 1) return undefined;
  let decoded: string;
  try {
    decoded = atob(body + "=".repeat((4 - (body.length % 4)) % 4));
  } catch {
    return undefined;
  }
  if (decoded.length < 24) return undefined;
  let printable = 0;
  let spaces = 0;
  for (let index = 0; index < decoded.length; index += 1) {
    const code = decoded.charCodeAt(index);
    if (code === 0x20) spaces += 1;
    if ((code >= 0x20 && code < 0x7f) || code === 0x0a || code === 0x0d || code === 0x09) {
      printable += 1;
    }
  }
  if (printable / decoded.length < 0.95) return undefined;
  if (spaces < 3 || spaces / decoded.length < 0.08) return undefined;
  return decoded;
}

function asksForExfiltration(text: string): boolean {
  if (IMAGE_BEACON.test(text)) return true;
  for (const sentence of sentences(text)) {
    if (SECRET_NOUN.test(sentence) && EGRESS_VERB.test(sentence) && DESTINATION.test(sentence)) {
      return true;
    }
  }
  return false;
}

/**
 * Sentences split at a line break or at sentence punctuation followed by a
 * space, so a dotted address stays whole. A long sentence is read in windows
 * that overlap by half, so a request split across a window edge is still seen.
 */
function* sentences(text: string): Generator<string> {
  for (const sentence of text.split(/\n|[.!?]\s/)) {
    if (sentence.length <= SENTENCE_WINDOW) {
      yield sentence;
      continue;
    }
    for (let start = 0; start < sentence.length; start += SENTENCE_WINDOW / 2) {
      yield sentence.slice(start, start + SENTENCE_WINDOW);
    }
  }
}
