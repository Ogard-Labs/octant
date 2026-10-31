# Search queries on a tainted thread

This topic specification owns the patterns that make the native harness refuse
a `web-search` query on a tainted thread. Architecture owns the rule itself:
on a tainted thread the tool-call policy refuses a query that looks like it
carries data, before any request leaves, with a named reason
([Architecture: native harness](../architecture.md#native-harness)). Today
that holds under every posture; the rule is that it follows the
[guardrail level](../architecture.md#security-and-authority): it refuses at
Guarded and Reviewed, warns at Trusted, and is off at Off (allowed;
not built yet).

## Refused patterns

A query is refused when it is longer than 200 characters; contains a URL (a
scheme, `www.`, a dotted name ending in letters or a punycode `xn--` label, with or
without a trailing root dot, followed by a path, query, or fragment,
optionally after a port, or an IPv4 address followed by a port or
path); contains an email address; contains a run of 16 or more hex digits;
contains three or more `%XX` or `\xXX` escaped bytes in a row; contains a
base64 run (24 or more base64
characters mixing upper case, lower case, and digits, or 16 or more ending
in `=` padding); or contains a token of 20 or more characters, split on
whitespace and path punctuation, that mixes letters and digits at 3.5 or more
bits of Shannon entropy per character.

## Verification

`searchQueryRefusalUnderTaint` in `packages/domain/src/untrustedContentPolicy.ts`
decides, and `packages/domain/src/untrustedContentPolicy.test.ts` holds its
tests.
