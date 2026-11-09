# Model benchmarks

Status: current approved design (approved by a maintainer on 2026-11-07),
built in six phases in the order under [Delivery](#delivery-in-order); all six
landed on 2026-11-09. This page owns
the rules for model benchmarks and is linked from the [design index](README.md).

## Why

Octant runs many providers and models (Claude Code, Codex, OpenCode, Pi, and
Octant Harness on direct endpoints). A person choosing between them needs
the same task measured the same way on each: how fast, how many tokens, what
it cost, how often tools failed, and how good the answer was. Diagnostics
already measures every turn. Benchmarks add three things on top:

1. **Same prompt, compared.** Ordinary threads that opened with the same prompt are
   grouped, so everyday use already compares models.
2. **Suites you can run.** A suite of prompt and Code tasks runs on chosen
   models in one go, with repetitions.
3. **Scores.** Automatic checks, an optional judge model, and the person's own
   stars, side by side.

## Concepts

| Term      | Meaning                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suite     | A named, host-local set of cases, and optionally a judge and a rubric.                                                                                                                                              |
| Case      | One task: a **prompt case** (a Chat prompt) or a **Code case** (a task prompt run against a repository at a pinned branch or tag). Each case has checks, an optional reference answer, and an optional rubric line. |
| Contender | A provider instance and model, with an optional reasoning effort. Octant Harness endpoints are contenders like any other.                                                                                           |
| Run       | One execution of a suite on chosen contenders, with 1–5 repetitions.                                                                                                                                                |
| Cell      | One case × contender × repetition: one ordinary new thread with one turn.                                                                                                                                           |

## Same prompt, compared (everyday turns)

- Each `turn-metrics-recorded` frame gains an optional `promptDigest`. It is an
  HMAC-SHA-256 of the prompt as sent, with whitespace normalized, keyed with a
  host-local secret. It is never the prompt text. Only a thread's first turn
  carries a digest, on its own context: a short follow-up such as "continue" or
  "yes" means something only inside its conversation, and grouping it with the
  same words elsewhere would compare unrelated work. A subagent result
  delivery, a branch's own turns, and a Code turn on a carried-in session,
  handoff, or fork are never first turns. The key never leaves the host,
  so a digest cannot be matched against a guessed prompt on another machine.
  A thread purge erases the frame and its digest.
- The diagnostics report adds a **Same prompt** list: prompts sent to two or
  more provider/model pairs, with each pair's p50 speed, first token, tokens,
  cost, and failure rate. A row names the newest thread that sent it, so the
  person reads the prompt in the thread, not in the report.

## Running a suite

- Only a **local window** creates or edits suites and starts runs, because a
  run spends money and can run code. A remote client can watch and read.
- Each cell is an ordinary thread, created the same way a routine creates one
  (Automation Center's dispatch: create the thread, set provider and model,
  send one turn with a deterministic submission id). Benchmark threads live in
  a dedicated **Benchmarks** Project, so Project spend ceilings apply. They are
  archived when the run ends and stay off the boards.
- The thread's `TurnMetricsRecord` supplies time, tokens, cost, tool failures,
  retries, and failure facts. The run stores only the joins and the scores.
- **Bounds.** The person sets a token and cost budget per run. Before each cell
  the host estimates the cell's cost from the cells that have finished. When
  the budget would be passed, the run stops as `budget-reached`. Cells run
  through the existing capacity scheduler, with at most two at once per provider
  instance and four per host, and person-started turns go first.
- **Code cases** run in a managed worktree created from the case's pinned branch
  or tag, never pushed, with delivery target "local only". The run picks an
  execution level at a local window: Auto or Accept edits, clamped to the
  Project's level, or Full access only where the Project already allows it. An
  approval that still blocks the turn ends the cell as `blocked-on-approval`,
  either after 10 minutes or when the turn ends first; it counts as a failure
  with that reason. The
  worktree is removed when the run is purged.

## Scoring

Three scores are shown side by side and never summed into one hidden number.
No score can mark a thread Done or change its delivery target.

1. **Checks** (automatic, deterministic):
   - Prompt cases: contains, does not contain, matches a regular expression,
     equals, and is valid JSON.
   - Code cases: a check command exits 0 (for example the test command). It
     runs in the cell's worktree after the turn, under the same confinement
     as the turn, with a 10-minute limit. The case can also cap the number of
     files changed.
   - The score is the share of checks passed.
2. **Judge** (optional, per suite): a judge provider and model and a rubric.
   - The judge gets the case prompt, the reference answer if there is one, and
     the candidate's answer. For a Code case it gets the diff summary and the
     check results instead.
   - It never learns which contender wrote the answer, and it has no tools.
   - It returns a score from 1 to 10 and a reason of at most 512 characters.
   - The same judge scores every contender in a run.
   - Judge tokens and cost are counted as the run's overhead, separate from any
     contender's.
3. **Stars**: the person rates a cell from 1 to 5, with an optional note, in any
   window of the host owner.

## Pages

A **Benchmarks** source joins Diagnostics in the Usage source switch:

- **Suites**: list, create, edit, and import or export as JSON.
- **Run builder**: pick the contenders and repetitions, set the budget, and,
  for Code cases, the execution level. It shows an estimated cost before
  starting.
- **Live grid**: cases × contenders, each cell queued, running, passed, failed,
  or blocked, with its time and tokens.
- **Leaderboard**: one row per contender with the check pass rate, mean judge
  score, mean stars, p50 and p95 first token and speed, tokens, cost, tool
  failure rate, and failures. Each column sorts, and each row opens the cells.
- **Case compare**: one case with each contender's answer side by side, its
  figures, its scores, and a star control.
- **History**: the same suite across runs, to see a new model version against
  the old.
- **Export**: the whole run as JSON or CSV for offline analysis.

## Storage

- `benchmark-suite` aggregate: definitions (cases, checks, judge, rubric).
  Prompt text lives here because the person wrote it as a definition.
- `benchmark-run` aggregate: contenders, budget, cells (thread id, status,
  check results, judge score and reason, stars and note).
- Answers are read from the cell threads, never copied into the run.
- Purging a run purges its threads and worktrees. Deleting a suite keeps
  finished runs until they are purged.

## Rules this keeps

- Provider-neutral: any provider that runs a Chat or Code turn can be a
  contender, through the existing provider seam. Nothing is wired for one
  vendor.
- An agent cannot mark Done; scores are readings only.
- Remote clients never exceed host grants: they view and rate, and never start
  runs or edit suites.
- Local-first: nothing leaves the host except the provider requests the run
  makes.

## Delivery, in order

1. Prompt digest and the Same prompt comparison in Diagnostics. (built)
2. Suite and run contracts, domain policy (cells, budget, scoring), journal
   aggregates, routes, and the prompt-case runner with checks. (built)
3. Benchmarks pages: suites, run builder, live grid, leaderboard, case
   compare. (built)
4. Judge scoring and stars. (built)
5. Code cases: pinned worktrees, check commands, approval handling. (built)
6. History across runs and export. (built)
