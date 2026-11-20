---
name: writing-octant-issues
description: How to write or rewrite a Linear issue so another agent can implement it without further context — verify the facts on main first, settle decisions with the maintainer, then write one self-contained brief with steps, stop conditions, tests and acceptance criteria that each say how they are verified.
---

# Writing Octant issues as implementation briefs

Use this when you create an issue, or rewrite one, that another agent will
implement. The goal is a brief an agent can start cold: everything it needs is
in the issue, every fact in it is true on `main`, and it can check its own work
against the issue without asking.

`AGENTS.md` still governs what an issue is (one outcome a person would notice,
one dated status block, maintainer-only checks on the "Maintainer live smokes"
issue). This skill covers how to write one well.

## The method

Do these in order. The headings in the template are the easy part; these steps
are what make a brief trustworthy.

1. **Find the owner first.** Search open issues for the same outcome. Add to
   that issue rather than filing a new one.
2. **Read the code on current `main`, not your memory or an older review.**
   Fetch, record the commit, and name the files, functions and constants the
   implementer will touch. Mark each fact as **verified** (you read it at that
   commit) or **reported** (someone else said it). Never state a reported fact
   as verified.
3. **Separate decisions from instructions.** List every choice the maintainer
   must make, each with your recommendation and its reason. Ask before writing
   steps that depend on the answer. Record each answer in a Decisions section
   with its date; a decision does not live only in a chat.
4. **Narrow what a weaker agent would otherwise guess.** Where a decision says
   "by default" or "where it makes sense", turn it into an explicit list (add /
   do not add / unchanged) and say so if the list is narrower than the decision.
5. **Require a written proposal before code** for any slice that changes cost
   (billed model calls), security, sandboxing or confinement, or the journal's
   event shapes. The proposal goes as a comment on the issue and needs the
   maintainer's approval.
6. **Give every boundary a stop condition.** For each rule the implementer
   could break (authority, a public package, a cap, an approval), add a "stop
   and ask" line. Also say what not to stop for (moved line numbers, a symbol
   found by search, pending maintainer checks).
7. **Tie tests to acceptance.** Number the acceptance criteria. Each criterion
   says how it is verified (a named test, a check, a rendered check, a diff
   review, a maintainer check). Each test to write first points at a criterion.
8. **Keep maintainer-only checks out of the implementer's path.** Anything that
   needs a signed-in account, billed turns, a device or a second machine is
   recorded once on the "Maintainer live smokes" issue. The implementer prepares
   for it and does not wait for it.
9. **Sequence related issues.** If issues touch the same files or one builds on
   another, write the order into each of them.
10. **Read it as a stranger, then read it back.** Before saving, reread the issue
    as if you knew nothing from your session. After saving, fetch it again and
    confirm the text landed; edits can fail on stored link markup.

## Template

Pick the size by the work, not by habit.

### Small fix

```markdown
## Outcome

One or two sentences a person would notice.

## Status — YYYY-MM-DD

**Delivery:** … **Evidence:** read at `<commit>`. **Remaining:** …

## What exists today (verified at `<commit>`)

Numbered facts with file and symbol names.

## Steps

Numbered, smallest complete change.

## Acceptance criteria

| # | Criterion | How it is verified |

## Do not

Scope traps.
```

### Feature or multi-slice

```markdown
## Outcome

What a person notices. One line on what this issue does not cover, and which issue does.

## Status — YYYY-MM-DD

Delivery, evidence (with commit), remaining. One block, replaced in place.

## Sequence

Order across issues and slices; what may run in parallel.

## Decisions (maintainer, date)

Numbered; each with the reason or condition. "No decision is open" when true.

## What exists today (verified at `<commit>`)

Numbered facts: files, functions, constants, current behaviour. Verified vs reported.

## Rules every slice keeps

Boundaries that hold throughout (authority, privacy, caps, replay, approvals).

## Before you start

Read list (AGENTS.md, owning specifications, named files), branch from current
main, record the commit, recheck the facts above.

## Stop and ask the maintainer when

One line per boundary.

## Slice N. <title>

### What exists today

### Steps

### Tests (write first)

### Done when

(Mark slices that need a proposal first, and list what the proposal answers.)

## Checks for every pull request

The repository scripts to run; report any check not run, with the reason.

## Maintainer check (not yours to run)

What it is and where it is recorded.

## Acceptance criteria

| # | Criterion | How it is verified |

## Deliver

Pull request shape, status update, "do not merge".

## Do not

Scope traps and boundaries, briefly.

## Related

Other issues and how they relate.
```

## Writing rules

- State facts, not history. Replace stale layers instead of adding "corrections"
  sections on top of an older text.
- Name things precisely: file paths, function and constant names, test names.
  Line numbers move; tell the implementer to find symbols by search.
- Tests are sentences about observable behaviour, written to fail first.
- Use the repository's own scripts in checks (`bun run test`, never raw
  `bun test`), and always `git diff --check`.
- Keep tracker identifiers out of code, comments, tests and specifications;
  they belong in issues and pull request descriptions only.
