/**
 * The host and port a harness tool egress rule names. Kept apart from the
 * rest of the egress vocabulary because a harness approval lists them too,
 * and the egress records already depend on the approval's id.
 */

import { Schema } from "effect";

export const MAX_TOOL_EGRESS_HOST_LENGTH = 253;

export const ToolEgressPort = Schema.Int.pipe(Schema.between(1, 65_535));
export type ToolEgressPort = typeof ToolEgressPort.Type;

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/**
 * A destination name in the form rules are compared in: lowercase IDNA ASCII,
 * letters, digits, and inner hyphens per label, at least two labels, no
 * trailing dot. The last label holds a letter, so a dotted IPv4 literal never
 * passes, and names under `localhost` are refused because they resolve to
 * loopback by definition.
 */
export const TOOL_EGRESS_HOST_NAME_PATTERN = new RegExp(
  `^(?:${DNS_LABEL}\\.)+(?!localhost$)(?=[a-z0-9-]*[a-z])${DNS_LABEL}$`,
);

/**
 * What a rule names: an exact name, or `*.` and a name, which matches that
 * name's subdomains and never the name itself. A wildcard needs at least two
 * labels after it, so `*.com` is not a rule.
 */
export const ToolEgressRuleHost = Schema.String.pipe(
  Schema.maxLength(MAX_TOOL_EGRESS_HOST_LENGTH),
  Schema.filter((value) => {
    const name = value.startsWith("*.") ? value.slice(2) : value;
    return name.length <= MAX_TOOL_EGRESS_HOST_LENGTH && TOOL_EGRESS_HOST_NAME_PATTERN.test(name);
  }),
  Schema.brand("ToolEgressRuleHost"),
);
export type ToolEgressRuleHost = typeof ToolEgressRuleHost.Type;
