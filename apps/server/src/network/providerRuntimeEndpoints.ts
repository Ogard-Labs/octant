import type { RuntimeNetworkRuntime } from "@octant/contracts/safe-networks";
import { canonicalToolEgressHost } from "@octant/domain/tool-egress-policy";
import type { AcpProviderKind } from "../providers/acpProfiles";

/**
 * Each provider runtime's own endpoints: the domains its sign-in, model
 * catalog, and inference use, each covering its subdomains, at port 443.
 * Canonical: docs/architecture.md § Provider runtime network.
 *
 * A runtime that serves several model providers lists the model providers it
 * offers out of the box. A base URL the launch's environment names (an
 * endpoint the person configured) is added for that launch. Anything else the
 * runtime asks for, its own web fetch included, needs the Project's egress
 * rules or a safe network, and a refusal names the host so the person can
 * trust it in Settings › Access.
 */

const MODEL_PROVIDERS: ReadonlyArray<string> = [
  "anthropic.com",
  "claude.ai",
  "openai.com",
  "chatgpt.com",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "oauth2.googleapis.com",
  "mistral.ai",
  "openrouter.ai",
  "x.ai",
  "groq.com",
  "deepseek.com",
  "together.xyz",
  "fireworks.ai",
  "cerebras.ai",
  "moonshot.ai",
  "z.ai",
  "bigmodel.cn",
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "cohere.com",
  "perplexity.ai",
  "openai.azure.com",
  "services.ai.azure.com",
  "models.dev",
];

const ACP_ENDPOINTS: Readonly<Record<AcpProviderKind, ReadonlyArray<string>>> = {
  opencode: ["opencode.ai", ...MODEL_PROVIDERS],
  kilo: ["kilo.ai", "kilocode.ai", ...MODEL_PROVIDERS],
  devin: ["devin.ai", "cognition.ai"],
  "mistral-vibe": ["mistral.ai"],
  "kimi-code": ["moonshot.ai", "moonshot.cn", "kimi.com"],
  grok: ["x.ai", "grok.com"],
  goose: MODEL_PROVIDERS,
  glm: ["z.ai", "bigmodel.cn"],
  gemini: [
    "generativelanguage.googleapis.com",
    "cloudcode-pa.googleapis.com",
    "oauth2.googleapis.com",
    "www.googleapis.com",
    "accounts.google.com",
  ],
  copilot: ["githubcopilot.com", "api.github.com", "github.com"],
  cline: ["cline.bot", ...MODEL_PROVIDERS],
  qwen: ["qwen.ai", "dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"],
  fx: MODEL_PROVIDERS,
};

const RUNTIME_ENDPOINTS: Readonly<
  Record<Exclude<RuntimeNetworkRuntime, "acp">, ReadonlyArray<string>>
> = {
  codex: ["openai.com", "chatgpt.com"],
  opencode: ["opencode.ai", ...MODEL_PROVIDERS],
  pi: MODEL_PROVIDERS,
  // Claude's own process: its sign-in, catalog, and inference.
  claude: ["anthropic.com", "claude.ai", "claude.com"],
  // Claude's sandbox carries the commands its shell runs, not the runtime's
  // own inference, so it has no provider endpoint of its own: a command
  // reaches the Project's rules and the safe networks.
  "claude-sandbox": [],
};

export function providerRuntimeDomains(input: {
  readonly runtime: RuntimeNetworkRuntime;
  readonly profileId?: AcpProviderKind | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
}): ReadonlyArray<string> {
  const listed =
    input.runtime === "acp"
      ? input.profileId === undefined
        ? []
        : ACP_ENDPOINTS[input.profileId]
      : RUNTIME_ENDPOINTS[input.runtime];
  return [...new Set([...listed, ...configuredEndpointHosts(input.environment)])];
}

/**
 * The hosts of the base URLs a launch's environment configures (`*_BASE_URL`,
 * `*_ENDPOINT`), which are the person's own endpoints for that runtime. A
 * value that is not an `https` URL with a public-looking name adds nothing:
 * a local endpoint is reached through a trusted `this-mac` or range place.
 */
function configuredEndpointHosts(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): ReadonlyArray<string> {
  if (environment === undefined) return [];
  const hosts: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || !/(?:_BASE_URL|_ENDPOINT)$/.test(key)) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) continue;
    const name = canonicalToolEgressHost(url.hostname);
    if (name.kind === "name") hosts.push(name.host);
  }
  return hosts;
}
