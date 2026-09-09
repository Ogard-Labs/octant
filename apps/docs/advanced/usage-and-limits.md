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
provider readings without requiring the chart.

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

The reader's cache and cursors are local to the host process and rebuild from
the provider files after a restart. Discovery and retained records are bounded;
coverage remains partial when those bounds prevent a complete reading.

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

## Related

- [Context budgets](/advanced/context-budgets)
- [Providers and models](/advanced/providers)
