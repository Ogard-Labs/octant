import {
  MAX_WORK_STATUS_EXCERPT_LENGTH,
  MAX_WORK_STATUS_ITEMS,
  WORK_STATUS_SECTIONS,
  type WorkStatusDate,
  type WorkStatusDatedItem,
  type WorkStatusDueState,
} from "@octant/contracts/work-project-status";

/**
 * The two files every Work Project folder carries (`docs/decisions/0118`).
 *
 * `AGENTS.md` is the person's standing brief for anyone working in the folder;
 * Octant seeds it once and never touches it again. `STATUS.md` is where the
 * work stands: the agent keeps it current, and Octant backfills the one
 * section it can know about on its own — what changed — when a turn forgets.
 */
export const WORK_AGENTS_FILE_NAME = "AGENTS.md";
export const WORK_STATUS_FILE_NAME = "STATUS.md";

/** Status older than this, or undated, is stale and earns a resume brief. */
export const DEFAULT_WORK_STATUS_STALE_AFTER_DAYS = 7;
/** A deadline this close counts as due soon. */
export const WORK_STATUS_DUE_SOON_DAYS = 3;

const LAST_UPDATED_PREFIX = "Last updated:";
const DATED_LINE = /^-\s*(\d{4}-\d{2}-\d{2})\b[\s:–—-]*(.*)$/;

export function workAgentsTemplate(projectName: string): string {
  return [
    `# ${projectName}`,
    "",
    "Standing brief for anyone — person or agent — working in this folder.",
    "Octant reads this file at the start of every task here and never edits it.",
    "",
    "## About this work",
    "",
    "- Who this is for (client, team, or purpose):",
    "- What we are trying to achieve:",
    "- Conventions, tone, file naming, anything to always respect:",
    "",
    "## Working here",
    "",
    "- Keep `STATUS.md` current: update **Current status**, **Follow-ups**, and",
    "  **Deadlines** before finishing a task, and set the `Last updated:` line.",
    "- Dates are written `YYYY-MM-DD` so Octant can remind about them.",
    "- Put produced documents in this folder or a subfolder; name them clearly.",
    "",
  ].join("\n");
}

export function workStatusTemplate(projectName: string, today: WorkStatusDate): string {
  return [
    `# ${projectName} — status`,
    "",
    `${LAST_UPDATED_PREFIX} ${today}`,
    "",
    `## ${WORK_STATUS_SECTIONS.currentStatus}`,
    "",
    "Nothing recorded yet.",
    "",
    `## ${WORK_STATUS_SECTIONS.followUps}`,
    "",
    "<!-- One per line, dated: - 2026-01-31 Call the client about the revised offer -->",
    "",
    `## ${WORK_STATUS_SECTIONS.deadlines}`,
    "",
    "<!-- One per line, dated: - 2026-02-14 Offer must be sent -->",
    "",
    `## ${WORK_STATUS_SECTIONS.recentChanges}`,
    "",
  ].join("\n");
}

export interface ParsedWorkStatus {
  readonly lastUpdatedOn: WorkStatusDate | undefined;
  readonly currentStatus: string | undefined;
  readonly followUps: ReadonlyArray<WorkStatusDatedItem>;
  readonly deadlines: ReadonlyArray<WorkStatusDatedItem>;
}

/**
 * Read the structured parts of `STATUS.md`. Everything else in the file is the
 * person's, and stays untouched. A line that does not fit the dated shape is
 * simply not a reminder; it is never an error.
 */
export function parseWorkStatus(text: string, today: WorkStatusDate): ParsedWorkStatus {
  const sections = splitSections(text);
  const lastUpdated = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(LAST_UPDATED_PREFIX))
    ?.slice(LAST_UPDATED_PREFIX.length)
    .trim();
  const currentStatus = sections.get(WORK_STATUS_SECTIONS.currentStatus)?.trim();
  return {
    lastUpdatedOn: isWorkStatusDate(lastUpdated) ? lastUpdated : undefined,
    currentStatus:
      currentStatus === undefined || currentStatus === ""
        ? undefined
        : currentStatus.slice(0, MAX_WORK_STATUS_EXCERPT_LENGTH),
    followUps: datedItems(sections.get(WORK_STATUS_SECTIONS.followUps), today),
    deadlines: datedItems(sections.get(WORK_STATUS_SECTIONS.deadlines), today),
  };
}

export function isWorkStatusDate(value: string | undefined): value is WorkStatusDate {
  return (
    value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
  );
}

/** Calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: WorkStatusDate, to: WorkStatusDate): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export function dueState(date: WorkStatusDate, today: WorkStatusDate): WorkStatusDueState {
  const days = daysBetween(today, date);
  if (days < 0) return "overdue";
  return days <= WORK_STATUS_DUE_SOON_DAYS ? "due-soon" : "upcoming";
}

export function isWorkStatusStale(
  parsed: Pick<ParsedWorkStatus, "lastUpdatedOn">,
  today: WorkStatusDate,
  staleAfterDays: number = DEFAULT_WORK_STATUS_STALE_AFTER_DAYS,
): boolean {
  return (
    parsed.lastUpdatedOn === undefined || daysBetween(parsed.lastUpdatedOn, today) > staleAfterDays
  );
}

export type WorkResumeBriefReason = "stale" | "overdue" | "due-soon";

/**
 * Whether a new task in this Project should open by taking stock rather than
 * diving in, and why. Nothing here fires for a Project whose status is fresh
 * and whose dates are comfortably ahead.
 */
export function decideWorkResumeBrief(
  parsed: ParsedWorkStatus,
  today: WorkStatusDate,
  staleAfterDays: number = DEFAULT_WORK_STATUS_STALE_AFTER_DAYS,
): ReadonlyArray<WorkResumeBriefReason> {
  const reasons: WorkResumeBriefReason[] = [];
  if (isWorkStatusStale(parsed, today, staleAfterDays)) reasons.push("stale");
  const dated = [...parsed.deadlines, ...parsed.followUps];
  if (dated.some((item) => item.state === "overdue")) reasons.push("overdue");
  if (dated.some((item) => item.state === "due-soon")) reasons.push("due-soon");
  return reasons;
}

export interface WorkRecentChange {
  readonly date: WorkStatusDate;
  readonly taskTitle: string;
  readonly paths: ReadonlyArray<string>;
  readonly truncated: boolean;
}

/**
 * Append what a turn changed under `Recent changes` without disturbing the
 * rest of the file. The section is created at the end when missing. Only the
 * paths are Octant's to assert — it observed them — so the entry says which
 * files changed in which task and nothing about what the change meant.
 */
export function appendWorkRecentChange(text: string, change: WorkRecentChange): string {
  const shown = change.paths.slice(0, 12);
  const more = change.paths.length - shown.length;
  const line = `- ${change.date} ${change.taskTitle}: ${shown.map((path) => `\`${path}\``).join(", ")}${
    more > 0 ? `, and ${String(more)} more` : ""
  }${change.truncated ? " (list incomplete)" : ""}`;
  const heading = `## ${WORK_STATUS_SECTIONS.recentChanges}`;
  const lines = text.split("\n");
  const headingIndex = lines.findIndex((candidate) => candidate.trim() === heading);
  if (headingIndex === -1) {
    const base = text.endsWith("\n") || text === "" ? text : `${text}\n`;
    return `${base}\n${heading}\n\n${line}\n`;
  }
  // Insert after the heading and its blank line so the newest change reads first.
  let insertAt = headingIndex + 1;
  while (insertAt < lines.length && lines[insertAt]?.trim() === "") insertAt += 1;
  const withBlank = insertAt === headingIndex + 1 ? ["", line] : [line];
  return [...lines.slice(0, insertAt), ...withBlank, ...lines.slice(insertAt)].join("\n");
}

function splitSections(text: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  let current: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (current !== undefined) sections.set(current, body.join("\n"));
  };
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      flush();
      current = heading[1];
      body = [];
    } else if (current !== undefined) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function datedItems(
  section: string | undefined,
  today: WorkStatusDate,
): ReadonlyArray<WorkStatusDatedItem> {
  if (section === undefined) return [];
  const items: WorkStatusDatedItem[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    const match = DATED_LINE.exec(line);
    const date = match?.[1];
    if (!isWorkStatusDate(date)) continue;
    const text = (match?.[2] ?? "").trim();
    if (text === "") continue;
    items.push({ date, text: text.slice(0, 512), state: dueState(date, today) });
    if (items.length >= MAX_WORK_STATUS_ITEMS) break;
  }
  return items;
}
