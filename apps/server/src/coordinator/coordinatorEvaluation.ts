export const fixtureProjectId = "40000000-0000-4000-8000-000000000001";

function worker(id: string, title: string, state: "working" | "idle") {
  return { id, reference: `${id}@${fixtureProjectId}`, title, state };
}

const palette = worker("20000000-0000-4000-8000-000000000002", "Update the palette", "working");
const typography = worker("20000000-0000-4000-8000-000000000003", "Update typography", "idle");

export interface EvaluationCase {
  readonly projectConversation?: true;
  readonly prompt: string;
  readonly workers: ReadonlyArray<ReturnType<typeof worker>>;
  readonly expected: {
    readonly action: "answer" | "start" | "send";
    readonly targets: ReadonlyArray<string>;
    readonly workerCount: number;
    readonly messageIncludes?: ReadonlyArray<string>;
  };
}

export const cases = {
  status: {
    prompt: "How many of your workers are currently working?",
    workers: [palette],
    expected: { action: "answer", targets: [], workerCount: 0 },
  },
  assign: {
    prompt:
      "Assign these two independent jobs to separate workers now: fix the CSV parser and update the changelog.",
    workers: [],
    expected: { action: "start", targets: ["parser", "changelog"], workerCount: 2 },
  },
  revise: {
    prompt: `Send the existing palette worker (${palette.reference}) this revision: use dark blue for the primary button.`,
    workers: [palette, typography] as const,
    expected: {
      action: "send",
      targets: [palette.reference],
      workerCount: 1,
      messageIncludes: ["dark blue", "primary button"],
    },
  },
  projectQuestion: {
    projectConversation: true,
    prompt: "Can the palette work continue while typography is idle?",
    workers: [palette, typography] as const,
    expected: { action: "answer", targets: [], workerCount: 0 },
  },
  projectAssign: {
    projectConversation: true,
    prompt:
      "The CSV parser mishandles quoted commas and the changelog still needs this release’s entries. Please get both done.",
    workers: [],
    expected: { action: "start", targets: ["parser", "changelog"], workerCount: 2 },
  },
  projectRevise: {
    projectConversation: true,
    prompt: "Change the palette assignment to use dark blue for the primary button.",
    workers: [palette, typography],
    expected: {
      action: "send",
      targets: [palette.reference],
      workerCount: 1,
      messageIncludes: ["dark blue", "primary button"],
    },
  },
} satisfies Record<string, EvaluationCase>;

export interface Action {
  readonly operation: string;
  readonly reference?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly startedReference?: string;
  readonly recipients?: ReadonlyArray<string>;
  readonly message?: string;
}

export function score(
  fixture: EvaluationCase,
  actions: ReadonlyArray<Action>,
  answer: string,
): boolean {
  const decisions = actions.filter(
    ({ operation }) => operation !== "list" && operation !== "help" && operation !== "read",
  );
  const { action, targets, workerCount, messageIncludes } = fixture.expected;
  if (action === "answer") return decisions.length === 0 && answer.trim().length > 0;
  if (decisions.some(({ operation }) => operation !== action)) return false;
  if (action === "send") {
    const recipients = decisions.flatMap(({ recipients }) => recipients ?? []);
    const message =
      decisions[0]?.message
        ?.toLowerCase()
        .replace(/\bprimary[\s-]+action[\s-]+button\b/g, "primary button") ?? "";
    return (
      decisions.length === 1 &&
      recipients.length === workerCount &&
      targets.every((target) => recipients.includes(target)) &&
      (messageIncludes ?? []).every((phrase) => message.includes(phrase))
    );
  }
  if (decisions.length !== workerCount) return false;
  if (fixture.projectConversation === true && !recapNamesWorkers(decisions, answer)) return false;
  const assignments = decisions.map(({ title, prompt }) => {
    if (!title?.trim() || !prompt?.trim()) return [];
    const titleMatches = targets.filter((target) => title.toLowerCase().includes(target));
    if (titleMatches.length === 1) return titleMatches;
    const brief = `${title} ${prompt}`.toLowerCase();
    return targets.filter((target) => brief.includes(target));
  });
  return (
    assignments.every((matches) => matches.length === 1) &&
    targets.every((target) => assignments.some((matches) => matches.includes(target)))
  );
}

function recapNamesWorkers(starts: ReadonlyArray<Action>, answer: string): boolean {
  const workers: Array<{ title: string; reference: string }> = [];
  for (const { title, startedReference } of starts) {
    if (!title?.trim() || !startedReference) return false;
    workers.push({ title: title.toLowerCase(), reference: startedReference });
  }

  const paired = new Set<string>();
  // A recap can repeat references in its introduction. Match within each
  // line so titles cannot cross list entries, and keep inline lists working.
  for (const line of answer.toLowerCase().split("\n")) {
    const mentions = workers
      .flatMap(({ title, reference }) => {
        const at = line.indexOf(reference);
        return at < 0 ? [] : [{ title, reference, at, end: at + reference.length }];
      })
      .sort((left, right) => left.at - right.at);
    if (
      mentions.every((entry, i) =>
        line.slice(mentions[i - 1]?.end ?? 0, entry.at).includes(entry.title),
      ) ||
      mentions.every((entry, i) => line.slice(entry.end, mentions[i + 1]?.at).includes(entry.title))
    ) {
      for (const { reference } of mentions) paired.add(reference);
    }
  }
  return workers.every(({ reference }) => paired.has(reference));
}

export type Sample =
  | {
      readonly status: "completed";
      readonly pass: boolean;
      readonly actions: ReadonlyArray<Action>;
    }
  | {
      readonly status: "error" | "incomplete";
      readonly reason: string;
      readonly actions: ReadonlyArray<Action>;
    };

export function summarize(samples: ReadonlyArray<Sample>) {
  const completed = samples.filter((sample) => sample.status === "completed");
  const passed = completed.filter((sample) => sample.pass).length;
  return {
    samples: samples.length,
    passed,
    failed: completed.length - passed,
    errors: samples.filter((sample) => sample.status === "error").length,
    incomplete: samples.filter((sample) => sample.status === "incomplete").length,
    passRate: completed.length === 0 ? null : passed / completed.length,
  };
}

export function compareSamples(baseline: ReadonlyArray<Sample>, candidate: ReadonlyArray<Sample>) {
  const before = summarize(baseline);
  const after = summarize(candidate);
  return {
    baseline: { ...before, runs: baseline },
    candidate: { ...after, runs: candidate },
    passRateDelta:
      before.passRate === null || after.passRate === null ? null : after.passRate - before.passRate,
  };
}
