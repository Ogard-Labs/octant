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

  const entries: string[] = [];
  let pending: { part: "title" | "reference"; value: string } | undefined;
  const implicit = new Set<string>();
  const referenceLines = new Set<string>();
  // An unlabelled continuation can supply the missing value. Keep it as a
  // fallback until the item ends so a later explicit field takes priority.
  const finishItem = (explicit?: string) => {
    const candidates = referenceLines.size > 0 ? referenceLines : implicit;
    const partner = explicit ?? (candidates.size === 1 ? [...candidates][0] : undefined);
    if (pending && partner) entries.push(pending.value + " " + partner);
    pending = undefined;
    implicit.clear();
    referenceLines.clear();
  };
  for (const raw of answer.toLowerCase().split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const marker = /^(?:[-+*]|\d+[.)]|#{1,6})\s+/.exec(line);
    const content = line.slice(marker?.[0].length ?? 0);
    const field = /^(?:\*\*|__)?(worker|reference)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*/.exec(content);
    const value = content.slice(field?.[0].length ?? 0);
    const lead = value.replace(/^[\s`*_[(<]+/, "");
    const refs = workers.filter(({ reference }) => value.includes(reference));
    const prose = refs.reduce((rest, { reference }) => rest.replaceAll(reference, " "), value);
    const titles = workers.filter(({ title }) => prose.includes(title));
    const leadingRef = refs.find(({ reference }) => lead.startsWith(reference));
    const leadingTitle = titles.find(({ title }) => lead.startsWith(title));
    // A name in a sentence is prose. A name on a line of its own can start an
    // entry even without a list marker or a Worker label.
    const standalone = lead.replace(/[\s`*_\])>:]+$/, "");
    const standaloneTitle = titles.find(({ title }) => standalone === title);
    const standaloneRef = refs.find(({ reference }) => standalone === reference);
    const titleHeading = field || marker ? leadingTitle : standaloneTitle;

    if (pending && !marker) {
      // The identifier in a reference field belongs to the preceding title.
      // An aside in that field may name a different worker.
      const fieldRef =
        leadingRef ?? (field?.[1] === "reference" && refs.length === 1 ? refs[0] : undefined);
      if (pending.part === "title" && field && fieldRef) {
        finishItem(fieldRef.reference);
        continue;
      }
      const fieldTitle =
        titleHeading ?? (field?.[1] === "worker" && titles.length === 1 ? titles[0] : undefined);
      if (pending.part === "reference" && fieldTitle && refs.length === 0) {
        finishItem(fieldTitle.title);
        continue;
      }
      if (!field && !standaloneTitle && !(pending.part === "reference" && standaloneRef)) {
        if (pending.part === "title" && leadingRef) {
          const suffix = lead.slice(leadingRef.reference.length).replace(/^[`*_\])>\s]+/, "");
          if (!suffix || suffix.startsWith("(")) referenceLines.add(leadingRef.reference);
        }
        for (const worker of pending.part === "title" ? refs : titles) {
          implicit.add(pending.part === "title" ? worker.reference : worker.title);
        }
        continue;
      }
    }
    finishItem();
    entries.push(value);
    const title = titleHeading ?? (titles.length === 1 ? titles[0] : undefined);
    if (refs.length === 0 && title && (marker || field || standaloneTitle)) {
      pending = { part: "title", value: title.title };
    } else if (refs.length === 1 && titles.length === 0 && leadingRef) {
      pending = { part: "reference", value: leadingRef.reference };
    }
  }
  finishItem();

  const paired = new Set<string>();
  for (const entry of entries) {
    const mentions = workers
      .flatMap(({ title, reference }) => {
        const at = entry.indexOf(reference);
        return at < 0 ? [] : [{ title, reference, at, end: at + reference.length }];
      })
      .sort((left, right) => left.at - right.at);
    if (
      mentions.every((mention, i) =>
        entry.slice(mentions[i - 1]?.end ?? 0, mention.at).includes(mention.title),
      ) ||
      mentions.every((mention, i) =>
        entry.slice(mention.end, mentions[i + 1]?.at).includes(mention.title),
      )
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
