import {
  AggregateId,
  AggregateVersion,
  BROWSER_FLOW_AGGREGATE_TYPE,
  CorrelationId,
  EventId,
  EventName,
  ProjectId as ProjectIdSchema,
  UtcTimestamp,
  BROWSER_FLOW_EVENT_NAMES,
  decodeBrowserFlow,
  decodeBrowserFlowDeleted,
  decodeBrowserFlowSaved,
  MAX_BROWSER_FLOW_BYTES,
  MAX_BROWSER_FLOW_STEPS,
  MAX_BROWSER_FLOWS_PER_PROJECT,
  type BrowserFlow,
  type BrowserFlowStep,
  type BrowserFlowSummary,
  type BrowserFlowTarget,
  decodeEventActor,
  type EventActor,
  type Project,
  type ProjectId,
  type ToolActionAuthority,
  type WindowId,
} from "@octant/contracts";
import { redactedBrowserUrl, type BrowserPageSnapshotRef } from "@octant/domain";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  isBrowserToolFlowInput,
  parseBrowserToolInput,
  type BrowserToolAnswer,
  type BrowserToolFlowInput,
  type BrowserToolInput,
  type BrowserToolStep,
} from "./browserToolOperations";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeProjectId = Schema.decodeUnknownSync(ProjectIdSchema);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const MAX_APPEND_ATTEMPTS = 3;
const PAGE_SIZE = 1_000;

/**
 * The flows a Project keeps. Each flow is one `browser.flow-saved@1` event on
 * the Project's flow aggregate and a delete is one `browser.flow-deleted@1`, so
 * the journal decides what exists and a restart rebuilds the same set. The
 * fold is held in memory per Project and read from the journal on first use.
 */
export class BrowserFlowService {
  readonly #journal: Pick<Journal, "append" | "replayAggregate">;
  readonly #connection: SqliteConnection;
  readonly #readProject: (projectId: ProjectId) => Project | undefined;
  readonly #personActor: EventActor;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #cache = new Map<string, Map<string, BrowserFlow>>();

  constructor(options: {
    readonly journal: Pick<Journal, "append" | "replayAggregate">;
    readonly connection: SqliteConnection;
    readonly readProject: (projectId: ProjectId) => Project | undefined;
    /** The journal actor for a flow the person deletes from a local window. */
    readonly personActor: EventActor;
    readonly uuid: () => string;
    readonly clock: () => string;
  }) {
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#readProject = options.readProject;
    this.#personActor = options.personActor;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  /** A Project's flows, by name. */
  list(projectId: ProjectId): ReadonlyArray<BrowserFlow> {
    return [...this.#flows(projectId).values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(projectId: ProjectId, name: string): BrowserFlow | undefined {
    return this.#flows(projectId).get(name);
  }

  /** Every Project's flows as a list shows them, for Settings. */
  summaries(): ReadonlyArray<BrowserFlowSummary> {
    const rows = this.#connection
      .prepare(`SELECT aggregate_id FROM aggregate_heads WHERE aggregate_type = ?`)
      .all(BROWSER_FLOW_AGGREGATE_TYPE) as ReadonlyArray<{ readonly aggregate_id: string }>;
    const summaries: BrowserFlowSummary[] = [];
    for (const row of rows) {
      const projectId = decodeProjectId(row.aggregate_id);
      const label = this.#readProject(projectId)?.name ?? "A Project that no longer exists";
      for (const flow of this.list(projectId)) {
        const firstAddress = firstFlowAddress(flow);
        summaries.push({
          projectId,
          projectLabel: label,
          name: flow.name,
          stepCount: flow.steps.length,
          ...(firstAddress === undefined ? {} : { firstAddress }),
          savedAt: flow.savedAt,
        });
      }
    }
    return summaries.sort(
      (a, b) => a.projectLabel.localeCompare(b.projectLabel) || a.name.localeCompare(b.name),
    );
  }

  /**
   * Save a run as a named flow, replacing one of the same name. A refusal is a
   * value: a Project keeps a bounded number of flows of a bounded size.
   */
  save(input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly steps: ReadonlyArray<BrowserFlowStep>;
    readonly actor: EventActor;
  }):
    | { readonly status: "saved"; readonly replaced: boolean }
    | {
        readonly status: "refused";
        readonly reason: "flow-store-full" | "flow-too-large";
      } {
    const flow = decodeBrowserFlow({
      name: input.name,
      steps: input.steps,
      savedAt: this.#clock(),
    });
    if (Buffer.byteLength(JSON.stringify(flow), "utf8") > MAX_BROWSER_FLOW_BYTES) {
      return { status: "refused", reason: "flow-too-large" };
    }
    const existing = this.#flows(input.projectId);
    const replaced = existing.has(flow.name);
    if (!replaced && existing.size >= MAX_BROWSER_FLOWS_PER_PROJECT) {
      return { status: "refused", reason: "flow-store-full" };
    }
    this.#append(
      input.projectId,
      BROWSER_FLOW_EVENT_NAMES.saved,
      { kind: "browser-flow-saved", projectId: input.projectId, flow },
      input.actor,
    );
    return { status: "saved", replaced };
  }

  /** Forget what was read for a Project whose records an erase just removed. */
  forget(projectId: ProjectId): void {
    this.#cache.delete(String(projectId));
  }

  /** Delete a flow; false when the Project has none of that name. */
  delete(projectId: ProjectId, name: string): boolean {
    if (!this.#flows(projectId).has(name)) return false;
    this.#append(
      projectId,
      BROWSER_FLOW_EVENT_NAMES.deleted,
      { kind: "browser-flow-deleted", projectId, name },
      this.#personActor,
    );
    return true;
  }

  #flows(projectId: ProjectId): Map<string, BrowserFlow> {
    const key = String(projectId);
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    const folded = new Map<string, BrowserFlow>();
    for (let afterVersion = 0; ;) {
      const page = this.#journal.replayAggregate({
        aggregateType: BROWSER_FLOW_AGGREGATE_TYPE,
        aggregateId: key,
        afterVersion,
        limit: PAGE_SIZE,
      });
      for (const event of page) {
        if (event.eventName === BROWSER_FLOW_EVENT_NAMES.saved) {
          const saved = decodeBrowserFlowSaved(event.payload);
          folded.set(saved.flow.name, saved.flow);
        } else if (event.eventName === BROWSER_FLOW_EVENT_NAMES.deleted) {
          folded.delete(decodeBrowserFlowDeleted(event.payload).name);
        }
        afterVersion = event.aggregateVersion;
      }
      if (page.length < PAGE_SIZE) break;
    }
    this.#cache.set(key, folded);
    return folded;
  }

  #append(projectId: ProjectId, eventName: string, payload: unknown, actor: EventActor): void {
    const aggregateId = decodeAggregateId(String(projectId));
    for (let attempt = 1; ; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, BROWSER_FLOW_AGGREGATE_TYPE, aggregateId),
      );
      try {
        this.#journal.append({
          aggregate: { aggregateType: BROWSER_FLOW_AGGREGATE_TYPE, aggregateId },
          expectedVersion,
          events: [
            {
              eventId: decodeEventId(this.#uuid()),
              eventName: decodeEventName(eventName),
              eventVersion: 1,
              correlationId: decodeCorrelationId(this.#uuid()),
              actor,
              occurredAt: decodeTimestamp(this.#clock()),
              payload,
            },
          ],
        });
        break;
      } catch (error) {
        if (!(error instanceof ConcurrencyConflict) || attempt >= MAX_APPEND_ATTEMPTS) throw error;
      }
    }
    // The next read folds the journal again, so a conflict cannot leave a
    // cached set that disagrees with it.
    this.#cache.delete(String(projectId));
  }
}

/** The address a flow opens with, when its first navigation names one. */
export function firstFlowAddress(flow: BrowserFlow): string | undefined {
  for (const step of flow.steps) {
    if (step.operation === "navigate" && typeof step.input.url === "string") return step.input.url;
  }
  return undefined;
}

/** What the recorder holds for one Browser context. */
export interface BrowserFlowRun {
  readonly steps: ReadonlyArray<BrowserFlowStep>;
  /** The operation that needs the person, when one was run: the run cannot be saved. */
  readonly blockedBy: string | undefined;
  /** The run grew past the step limit. */
  readonly overflowed: boolean;
}

const MAX_RECORDED_CONTEXTS = 256;

/**
 * The agent's successful operations on each Browser context since its page
 * opened. In memory only: a flow exists once a person-visible `flow-save`
 * writes it, and a restart ends every page anyway.
 */
export class BrowserFlowRecorder {
  readonly #runs = new Map<
    string,
    { steps: BrowserFlowStep[]; blockedBy: string | undefined; overflowed: boolean }
  >();

  #run(contextId: string) {
    let run = this.#runs.get(contextId);
    if (run === undefined) {
      if (this.#runs.size >= MAX_RECORDED_CONTEXTS) {
        const oldest = this.#runs.keys().next().value;
        if (oldest !== undefined) this.#runs.delete(oldest);
      }
      run = { steps: [], blockedBy: undefined, overflowed: false };
      this.#runs.set(contextId, run);
    }
    return run;
  }

  record(contextId: string, step: BrowserFlowStep): void {
    const run = this.#run(contextId);
    if (run.steps.length >= MAX_BROWSER_FLOW_STEPS) {
      run.overflowed = true;
      return;
    }
    run.steps.push(step);
  }

  /** An operation that needs the person ran: nothing from this page can be saved. */
  block(contextId: string, operation: string): void {
    const run = this.#run(contextId);
    run.blockedBy ??= operation;
  }

  forget(contextId: string): void {
    this.#runs.delete(contextId);
  }

  read(contextId: string): BrowserFlowRun | undefined {
    const run = this.#runs.get(contextId);
    return run === undefined
      ? undefined
      : { steps: [...run.steps], blockedBy: run.blockedBy, overflowed: run.overflowed };
  }
}

/** Who is behind a turn, for the rules on who may save and run a flow. */
export type BrowserFlowCaller = "person" | "unattended" | "paired-device";

/** What an adapter needs to record, save, list and replay flows. */
export interface BrowserFlowToolPort {
  readonly service: Pick<BrowserFlowService, "list" | "get" | "save">;
  readonly recorder: BrowserFlowRecorder;
  readonly caller: (windowId: WindowId) => BrowserFlowCaller;
}

/** What the latest snapshot's refs name, as the server keeps them. */
export type BrowserFlowRefs = ReadonlyArray<BrowserPageSnapshotRef>;

/** Operations stored as a flow's steps: the ones that act on the page or its tabs. */
const STORED_OPERATIONS: ReadonlySet<string> = new Set([
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "wait",
  "hover",
  "select",
  "drag",
  "resize",
  "tab-open",
  "tab-switch",
  "tab-close",
]);
/** Reads and listings: harmless, and a replay has no use for them. */
const UNSTORED_OPERATIONS: ReadonlySet<string> = new Set([
  "snapshot",
  "screenshot",
  "read-page",
  "diagnostics",
  "tab-list",
  "help",
]);

/**
 * The operation as the tool takes it, without the call-level extras that mean
 * nothing on a later page: the observation revision it was chosen from and the
 * `include` it asked for.
 */
export function browserToolInputRecord(
  input: Exclude<BrowserToolInput, { readonly operation: "steps" }>,
): Record<string, unknown> {
  const { expectedObservationRevision: _revision, include: _include, ...rest } = input;
  const record: Record<string, unknown> = { ...rest };
  if ("to" in rest) {
    delete record.to;
    if ("ref" in rest.to) record.toRef = rest.to.ref;
    else record.toSelector = rest.to.selector;
  }
  if ("viewport" in rest) {
    delete record.viewport;
    if (rest.viewport !== undefined) {
      record.width = rest.viewport.width;
      record.height = rest.viewport.height;
    }
  }
  if ("waitFor" in rest) {
    delete record.waitFor;
    record.conditions = rest.waitFor.conditions.map((condition) => {
      if (condition.kind === "text") return { text: condition.text, present: condition.present };
      if (condition.kind === "url") return { urlContains: condition.contains };
      if (condition.kind === "load") return { load: condition.state };
      return {
        ...(condition.ref === undefined ? { selector: condition.target } : { ref: condition.ref }),
        state: condition.state,
      };
    });
    record.match = rest.waitFor.match;
    if (rest.waitFor.timeoutMs !== undefined) record.timeoutMs = rest.waitFor.timeoutMs;
  }
  return record;
}

type StoredFlowDecision =
  | { readonly kind: "unstored" }
  | { readonly kind: "stored" }
  | { readonly kind: "needs-a-person"; readonly operation: string };

/** Which of the agent's operations a flow keeps, skips, or cannot hold at all. */
export function flowDecision(input: BrowserToolInput): StoredFlowDecision {
  if (UNSTORED_OPERATIONS.has(input.operation)) return { kind: "unstored" };
  if (!STORED_OPERATIONS.has(input.operation)) {
    // Upload, sign-in, stop, and anything added later that needs the person
    // (a download save): a flow never holds a step the person had to answer.
    return { kind: "needs-a-person", operation: input.operation };
  }
  if (input.operation === "navigate" && input.profile !== undefined) {
    return { kind: "needs-a-person", operation: "navigate with a profile" };
  }
  const address =
    input.operation === "navigate" || input.operation === "tab-open" ? input.url : undefined;
  if (address !== undefined && addressHoldsASecret(address)) {
    return { kind: "needs-a-person", operation: "an address with a secret in it" };
  }
  return { kind: "stored" };
}

/**
 * A fragment never reaches a server and often carries a token (an OAuth
 * callback's `#access_token=`), and a replay needs only the document, so the
 * stored address leaves it out.
 */
function withoutFragment(record: Record<string, unknown>): Record<string, unknown> {
  const address = record.url;
  if (typeof address !== "string") return record;
  try {
    const url = new URL(address);
    if (url.hash === "") return record;
    url.hash = "";
    return { ...record, url: url.toString() };
  } catch {
    return record;
  }
}

/** A user, a password, or a secret-looking query value would be saved with the flow. */
function addressHoldsASecret(address: string): boolean {
  try {
    const url = new URL(address);
    url.hash = "";
    return redactedBrowserUrl(address) !== url.toString();
  } catch {
    return false;
  }
}

const REF_KEY = /^(ref|toRef|conditions\.([0-4]))$/;

/**
 * Replace each ref of a stored operation with the role and name the latest
 * snapshot gave it. Undefined when a ref is not in the snapshot the server
 * holds, which means the step cannot be stored faithfully.
 */
export function describeFlowTargets(
  record: Record<string, unknown>,
  refs: BrowserFlowRefs,
):
  | {
      readonly input: Record<string, unknown>;
      readonly targets?: Record<string, BrowserFlowTarget>;
    }
  | undefined {
  const input: Record<string, unknown> = { ...record };
  const targets: Record<string, BrowserFlowTarget> = {};
  const describe = (ref: unknown): BrowserFlowTarget | undefined => {
    const entry = refs.find((candidate) => candidate.ref === ref);
    // A page chooses its own role, name, and ids, so a value past what a flow
    // may hold cannot be stored faithfully: the run ends there instead. The
    // selector is only a hint for a reader, so an overlong one is left out.
    if (entry === undefined || entry.role.length > 64 || entry.name.length > 512) return undefined;
    return {
      role: entry.role,
      name: entry.name,
      ...(entry.selector.length > 4096 ? {} : { selector: entry.selector }),
    };
  };
  for (const key of ["ref", "toRef"] as const) {
    if (record[key] === undefined) continue;
    const target = describe(record[key]);
    if (target === undefined) return undefined;
    targets[key] = target;
    delete input[key];
  }
  if (Array.isArray(record.conditions)) {
    const conditions: unknown[] = [];
    for (const [index, condition] of record.conditions.entries()) {
      const ref = (condition as { readonly ref?: unknown }).ref;
      if (ref === undefined) {
        conditions.push(condition);
        continue;
      }
      const target = describe(ref);
      if (target === undefined) return undefined;
      targets[`conditions.${String(index)}`] = target;
      const { ref: _ref, ...rest } = condition as Record<string, unknown>;
      conditions.push(rest);
    }
    input.conditions = conditions;
  }
  return Object.keys(targets).length === 0 ? { input } : { input, targets };
}

/** The page after a step, from the answer: its path and title, never its text. */
export function flowOutcomeOf(answer: BrowserToolAnswer): {
  readonly path: string;
  readonly title?: string;
} {
  const page = (
    answer.result as { readonly page?: { readonly url?: unknown; readonly title?: unknown } }
  ).page;
  const url = typeof page?.url === "string" ? page.url : undefined;
  let path = "";
  if (url !== undefined) {
    try {
      path = new URL(url).pathname;
    } catch {
      path = "";
    }
  }
  const title = typeof page?.title === "string" ? page.title.slice(0, 1024) : undefined;
  return { path: path.slice(0, 2048), ...(title === undefined ? {} : { title }) };
}

/**
 * Run one operation of the agent's and keep it for a flow. The refs are read
 * before the operation runs, because it may replace them; the step is kept
 * only if the operation succeeded, and an operation that needs the person
 * marks the page's run as one that cannot be saved.
 */
export async function runRecordingFlow(input: {
  readonly step: BrowserToolInput;
  readonly flows: BrowserFlowToolPort | undefined;
  readonly refs: () => BrowserFlowRefs;
  readonly contextId: () => string | undefined;
  readonly run: () => Promise<BrowserToolAnswer>;
}): Promise<BrowserToolAnswer> {
  const { flows, step } = input;
  if (flows === undefined || step.operation === "steps" || isBrowserToolFlowInput(step)) {
    return input.run();
  }
  const before = input.contextId();
  const decision = flowDecision(step);
  const record = decision.kind === "stored" ? browserToolInputRecord(step) : undefined;
  const described =
    record === undefined ? undefined : describeFlowTargets(withoutFragment(record), input.refs());
  const answer = await input.run();
  if (answer.isError) return answer;
  // A navigation that opens the page creates the context, so ask after.
  const contextId = input.contextId() ?? before;
  if (step.operation === "stop") {
    if (before !== undefined) flows.recorder.forget(before);
    return answer;
  }
  if (contextId === undefined) return answer;
  if (decision.kind === "needs-a-person") {
    flows.recorder.block(contextId, decision.operation);
  } else if (decision.kind === "stored") {
    if (described === undefined) {
      flows.recorder.block(contextId, "an element the flow cannot describe");
    } else {
      flows.recorder.record(contextId, {
        operation: step.operation,
        input: described.input,
        ...(described.targets === undefined ? {} : { targets: described.targets }),
        expect: flowOutcomeOf(answer),
      });
    }
  }
  return answer;
}

function refusal(error: string, extra: Record<string, unknown> = {}): BrowserToolAnswer {
  return { result: { error, ...extra }, isError: true };
}

/**
 * Save, list, and replay the Project's flows. `run` is the adapter's ordinary
 * path for one operation, so every replayed step is admitted exactly as a
 * single call would be.
 */
export async function runBrowserFlowOperation(
  input: BrowserToolFlowInput,
  deps: {
    readonly flows: BrowserFlowToolPort;
    readonly projectId: ProjectId | undefined;
    readonly caller: BrowserFlowCaller;
    readonly actor: () => EventActor;
    readonly contextId: () => string | undefined;
    readonly refs: () => BrowserFlowRefs;
    readonly run: (step: BrowserToolStep) => Promise<BrowserToolAnswer>;
  },
): Promise<BrowserToolAnswer> {
  const { flows, projectId } = deps;
  if (projectId === undefined) return refusal("flow-needs-a-project");
  if (input.operation === "flow-list") {
    return {
      result: {
        flows: flows.service.list(projectId).map((flow) => ({
          name: flow.name,
          steps: flow.steps.length,
          ...(firstFlowAddress(flow) === undefined ? {} : { firstAddress: firstFlowAddress(flow) }),
        })),
      },
      isError: false,
    };
  }
  // A paired device may not navigate or type, and a flow is both.
  if (deps.caller === "paired-device") return refusal("flow-needs-this-computer");
  if (input.operation === "flow-save") {
    // Saving writes a Project's data for good; nobody is there to have meant it
    // on a routine's or a subagent's turn.
    if (deps.caller === "unattended") return refusal("flow-needs-a-person");
    const contextId = deps.contextId();
    if (contextId === undefined) return refusal("browser-navigation-required");
    const run = flows.recorder.read(contextId);
    if (run?.blockedBy !== undefined) {
      return refusal("flow-run-needs-a-person", { operation: run.blockedBy });
    }
    if (run === undefined || run.steps.length === 0) return refusal("flow-nothing-to-save");
    if (run.overflowed) return refusal("flow-run-too-long", { limit: MAX_BROWSER_FLOW_STEPS });
    let saved: ReturnType<BrowserFlowToolPort["service"]["save"]>;
    try {
      saved = flows.service.save({
        projectId,
        name: input.name,
        steps: run.steps,
        actor: deps.actor(),
      });
    } catch {
      // A run that does not fit the stored shape is refused like one that is
      // too large; the page, not the agent, chose some of what it holds.
      return refusal("flow-too-large");
    }
    if (saved.status === "refused") return refusal(saved.reason);
    return {
      result: { saved: input.name, steps: run.steps.length, replaced: saved.replaced },
      isError: false,
    };
  }
  const flow = flows.service.get(projectId, input.name);
  if (flow === undefined) return refusal("flow-not-found");
  return replayBrowserFlow(flow, deps);
}

/** What one replayed step answered, for the lines of a successful run. */
interface ReplayedStep {
  readonly step: number;
  readonly operation: string;
  readonly changed?: string;
}

/**
 * Run a flow's steps in order, with no model turn between them. A step that
 * acted on an element first takes a snapshot and finds that element by its
 * role and name: exactly one match, or the replay stops. After each step the
 * page's path and title are compared with the recorded ones; the first step
 * that differs, fails, or is refused ends the replay and is named.
 */
async function replayBrowserFlow(
  flow: BrowserFlow,
  deps: {
    readonly refs: () => BrowserFlowRefs;
    readonly run: (step: BrowserToolStep) => Promise<BrowserToolAnswer>;
  },
): Promise<BrowserToolAnswer> {
  const completed: ReplayedStep[] = [];
  let last: BrowserToolAnswer | undefined;
  const stopped = (
    index: number,
    operation: string,
    detail: Record<string, unknown>,
  ): BrowserToolAnswer => ({
    result: { flow: flow.name, completed, failedStep: { step: index + 1, operation, ...detail } },
    isError: true,
  });
  for (const [index, stored] of flow.steps.entries()) {
    const record: Record<string, unknown> = { ...stored.input };
    if (stored.targets !== undefined && Object.keys(stored.targets).length > 0) {
      const snapshot = await deps.run({ operation: "snapshot" });
      if (snapshot.isError) {
        return stopped(index, stored.operation, { answer: snapshot.result });
      }
      const refs = deps.refs();
      for (const [key, target] of Object.entries(stored.targets)) {
        const matches = refs.filter(
          (candidate) => candidate.role === target.role && candidate.name === target.name,
        );
        const only = matches.length === 1 ? matches[0] : undefined;
        if (only === undefined || !REF_KEY.test(key)) {
          return stopped(index, stored.operation, {
            reason: matches.length === 0 ? "element-not-found" : "element-not-unique",
            element: { role: target.role, name: target.name },
            ...(matches.length > 1 ? { matches: matches.length } : {}),
          });
        }
        if (key === "ref" || key === "toRef") {
          record[key] = only.ref;
        } else {
          const at = Number(key.slice("conditions.".length));
          const conditions = Array.isArray(record.conditions) ? [...record.conditions] : [];
          conditions[at] = { ...(conditions[at] as Record<string, unknown>), ref: only.ref };
          record.conditions = conditions;
        }
      }
    }
    // The tool's own parser reads the step, so a stored step can ask for
    // nothing a call could not, and never for a profile or an upload.
    const parsed = parseBrowserToolInput(JSON.stringify(record), { allowProfile: false });
    if (
      parsed === undefined ||
      parsed.operation !== stored.operation ||
      parsed.operation === "steps" ||
      parsed.operation === "upload" ||
      parsed.operation === "stop" ||
      parsed.operation === "sign-in" ||
      isBrowserToolFlowInput(parsed)
    ) {
      return stopped(index, stored.operation, { reason: "step-not-valid" });
    }
    const answer = await deps.run(parsed);
    if (answer.isError) {
      return stopped(index, stored.operation, { answer: answer.result });
    }
    const found = flowOutcomeOf(answer);
    const changed = (answer.result as { readonly page?: { readonly changed?: unknown } }).page
      ?.changed;
    const differs =
      (stored.expect.path !== "" && found.path !== stored.expect.path) ||
      (stored.expect.title !== undefined && found.title !== stored.expect.title);
    if (differs) {
      return stopped(index, stored.operation, {
        reason: "page-differs",
        expected: stored.expect,
        found,
        ...(typeof changed === "string" ? { changed } : {}),
      });
    }
    completed.push({
      step: index + 1,
      operation: stored.operation,
      ...(typeof changed === "string" ? { changed } : {}),
    });
    last = answer;
  }
  return {
    result: { ...(last?.result as Record<string, unknown>), flow: flow.name, steps: completed },
    isError: false,
  };
}

/** The journal actor for a flow the agent saved: the provider driving this thread. */
export function browserFlowAgentActor(
  authority: ToolActionAuthority,
  threadId: string,
): EventActor {
  return decodeEventActor({
    kind: "agent",
    actorId: authority.providerInstanceId,
    providerInstanceId: authority.providerInstanceId,
    threadId,
  });
}
