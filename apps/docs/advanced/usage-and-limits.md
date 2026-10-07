---
description: Read local provider history, compare token and cost estimates, and inspect remaining account capacity.
---

# Usage and limits

Open **Usage** from the account menu. On a local host, **Local provider history**
reads supported provider accounting files, including activity created outside
Octant. **Octant records** opens the existing attributed ledger. These sources
can overlap, so their totals are never added together.

## History

Choose **Tokens** or **Cost**, then a period: past 24 hours, 7 days, 30 days, or
90 days. The overview shows a total, provider breakdown, and daily chart. The
Model and Day tables show the breakdown; **View chart data** exposes individual
provider readings without requiring the chart. Both daily tables run from the
earliest date to the latest, regardless of provider file scan order.

Large histories are read in bounded batches. Available totals appear while the
import continues. Changing the period cancels the previous query. Refresh keeps
the previous reading visible, and a failed refresh labels it as stale. Source
coverage distinguishes complete readings from unavailable files, malformed
records, and safety limits. A partial total is not the account's complete total.

History readers follow enabled, admitted providers. The current built-in readers support:

| Source          | Read scope                                                              | Monetary readings                                                                                                      |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Codex           | Local `sessions` and `archived_sessions` under the Codex data directory | Standard API-equivalent estimates when the model and required token categories are known                               |
| Claude Code     | Local JSONL accounting records under `.claude/projects`                 | Source-recorded costs when present; otherwise standard API-equivalent estimates when all required categories are known |
| Other providers | No built-in local-history reader yet                                    | Unavailable in this source; existing Octant records remain separate                                                    |

Only accounting fields survive parsing. Conversation bodies, tool arguments,
configuration, credentials, and auth files are not returned or stored as usage
records. Codex worktrees, repositories, and other sibling directories are not
scanned. The original provider files remain unchanged.

The reader saves accounting records and import cursors in the host's local data
directory and restores them after a restart. Discovery and retained records are
bounded; coverage remains partial when those bounds prevent a complete reading.

## Cost and cache savings

**API-equivalent estimate** applies a versioned snapshot of standard API token
rates. It is not a subscription invoice or a claim about what was charged in the
past. **Provider-recorded cost** preserves monetary facts present in the source.
If both are available, the Cost source selector keeps them separate.

Source coverage includes the pricing reference and revision. The view reports
how many records have pricing. Unknown models, absent prices, and missing token
categories stay unavailable instead of becoming free usage.

Processed input includes cached input; cache tokens are not added again to the
processed total. Output counts do not add reasoning a second time. Estimated
cache savings compare the priced input with the same input at the uncached rate
for that model and context tier. Negative savings mean cache-write overhead.
Partial measurement coverage is displayed with the value.

**Input cache hit rate** divides cached input by total processed input in the
selected local history reading. It is weighted by token counts across requests,
not an average of model percentages. Cache writes count toward input, not hits.
The rate is unavailable if any recorded request lacks cache-read measurements,
if input is zero, or if the counts contradict each other. Source coverage still
applies: a partial import describes only the records read so far.

## The stats line under every thread

Under the composer of every Chat, Work, and Code thread, on every provider, a
quiet line states what the thread has used so far:

`↑ 48k in · ↓ 3.1k out · cache 92% · 41 tok/s · 0.9 s first token · $0.03 est.`

- **in** is all input, cached or not. **out** is all output, reasoning included.
- **cache** is the share of input served from the prompt cache. A hit that was
  not total never reads as 100%: it gains decimals instead (99.5%, then 99.95%).
- **tok/s** is output tokens per second over the time the model spent
  generating, with tool time taken out. It is a whole number from 10 up and has
  one decimal below that. A leading `~` means the provider reported one figure
  for a turn that also ran tools, so some tool time may be inside it; hover for
  the explanation.
- **first token** is the wait from sending the prompt to the first streamed
  word, averaged over the turns that were measured.
- **cost** says **est.** because Octant prices tokens at the standard API rates
  for the model. A cost the provider reported itself drops the **est.**.

A figure the provider did not report, and one that cannot be measured, is left
out: Octant never shows a zero it did not see. A provider that reports no usage
shows no line at all. A thread with more than 50 turns prices its latest 50, and
the cost tooltip says so.

Click the line, or choose **Turn details** in the context meter's popover, to
open one turn at a time: input, cache read, cache write, output, and reasoning
tokens; first token, speed, model time, tool time, requests, and retries; and
the turn's cost. Use the arrows to step between turns. The details are
available whether or not the line is shown.

Hide the line with the eye button at its end, with **Stats line under the
composer** in the context meter's popover, or in **Settings › Appearance ›
Reading**. It is on by default, and the choice is saved for this installation.
The same figures appear on the Octant Harness session card, in the terminal
footer, and on the phone's session panel.

## Threads on the usage page

Octant records, on the Usage page and in Settings, list each thread with those
same figures. Cache, speed, and first token are columns, and a column is left
out when no thread in the reading can state it. Open a row to see one turn at
a time, worded the same way. A partial cache hit is never rounded up to 100%.
An approximate speed keeps its tilde, and an estimated cost keeps **est.** A
reading that still has older turns outside the list says so, and does not
present that partial list as the thread's full total.

## Remaining capacity

Provider limits show the percentage left and the time until a reset. Absolute
limits also show remaining counts when the provider reports them. Account,
model, and provider-instance scope are labeled separately; account limits can
include usage from other applications.

Codex supports a read-only account refresh while idle. That request creates no
thread or model turn. Other providers contribute windows when their supported
runtime or response headers report them. A provider that reports no quota data
stays unavailable; Octant does not infer a balance from token history.

An expired reset time means **Awaiting updated limits**, not an assumed refill.
A failed refresh retains the previous reading with a stale label. Limits are
available to the local authenticated host interface, not automatically to a
remote client merely because it can read a Project.

## Restart-safe local history

Octant saves its bounded local accounting index and import checkpoints in its
own data directory. The Host settings Data map lists this file as **Local provider
usage history**. Restarting restores imported usage instead of recounting
unchanged provider logs. Refresh reads new or changed files and continues any
unfinished import. Changing the date range or viewing timezone summarizes the
saved accounting records; it does not reset the importer.

This cache contains accounting facts and file checkpoints, not conversation
text or credentials. It remains separate from Octant-attributed usage. An old
or invalid cache is rebuilt from the recognized provider files; if the cache
cannot be saved, Usage reports partial coverage and explains the problem.

Opening Usage paints the host's last stored reading of the selected view and
reads again behind it, so an unchanged provider history opens at its totals
instead of repainting them while the import runs. Those totals carry the read
time of the earlier reading and are replaced when the current read finishes.
Normally that is the last completed reading. On a view that has never produced
a completed reading yet, the last unfinished reading is the fallback that is
kept, and it is replaced when a scan finishes.

## Turns stopped by a provider limit

When a provider's own protocol signal stops a turn on a usage limit, the
transcript shows a warning with what happened and — when the provider declared
one — the reset time as a countdown. Three kinds are distinguished: a temporary
rate limit, an exhausted allowance, and a billing or credit problem.

Only the provider's declared signal counts: account telemetry alone never turns
an ordinary failure into a limit stop, so a provider with no such signal keeps
its ordinary error. When no reset time is reported the notice says so rather
than estimating, and a billing stop shows no countdown — an account in arrears
does not free up on a clock.

The notice belongs to the stopped turn alone. Retrying the turn, a successful
recovery, or a different failure clears it. Recovery is always your explicit
retry — Octant never resumes a limited turn on its own.

## Related

- [Context budgets](/advanced/context-budgets)
- [Providers and models](/advanced/providers)
