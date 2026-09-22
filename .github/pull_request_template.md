## What

One or two sentences: what changes and why a user or contributor cares.

## How to verify

Map changed acceptance criteria to evidence: check/scenario, commit or build,
environment, result, and limitations. Existing evidence may be reused when its
relevant inputs are unchanged; label cached results. Name any exact remaining
closure action and its owner.

## Checklist

- [ ] Existing or new coverage and applicable acceptance checks prove the changed behavior; omissions are explained
- [ ] Applicable local checks pass under AGENTS.md; required exact-head CI must pass before merge
- [ ] Current specification and affected user docs describe the resulting behavior; conflicting summaries are reconciled
- [ ] No unrelated changes

Issue closure follows [AGENTS.md](../AGENTS.md#issue-closeout). A passing check
or ready PR alone does not imply that the issue's delivery target is met.
