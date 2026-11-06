import { GOOGLE_WORKSPACE_SERVICES } from "./googleWorkspaceConnectors";

/**
 * The connectors catalog: hosted MCP servers a person can connect from
 * Settings by name. Every entry is data the app ships with, naming only the
 * vendor's own address; nothing here is fetched. Connecting makes an
 * ordinary user-added server package, then either starts the MCP
 * authorization sign-in or takes a key the vendor issues.
 */
export type ConnectorAuth =
  /** Account consent uses MCP OAuth; a closed catalog policy may first require an owned app. */
  | {
      readonly kind: "sign-in";
      readonly clientSetup?: "registered";
      readonly setupGuide?: string;
      readonly requestedScopes?: readonly string[];
      /** Plain-language authority disclosed before app consent, not a tool approval. */
      readonly permissionNotice?: string;
    }
  /** The server takes a token the person creates with the vendor, sent in one header. */
  | {
      readonly kind: "key";
      readonly header: string;
      readonly prefix?: string;
      readonly keyPage: string;
    }
  /** The server answers without a credential. */
  | { readonly kind: "none" };

export type ConnectorCategory = "popular" | "developer-tools" | "business";

export interface ConnectorCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  /** One line: what the agent can do with it. */
  readonly description: string;
  readonly category: ConnectorCategory;
  readonly url: string;
  readonly auth: ConnectorAuth;
}

export const CONNECTOR_CATEGORY_LABEL: Readonly<Record<ConnectorCategory, string>> = {
  popular: "Popular",
  "developer-tools": "Developer tools",
  business: "Business",
};

/**
 * Entries were probed on 2026-10-20 (Doop on 2026-11-01): each sign-in server answered a bare
 * request with 401 and resource metadata, its authorization server published
 * metadata with PKCE S256 and dynamic client registration; each key server
 * answered 401 without registration; each open server answered without a
 * credential. An address that stops behaving that way belongs out, not fixed
 * up in the UI. Slack is separately documented on 2026-11-02: its exact dedicated
 * metadata requires a person-owned registered confidential client and a single
 * public-search scope; no live registration/consent/tool acceptance is claimed.
 * Google entries are Developer Preview: the 2026-11-03 documentation establishes
 * agentic Desktop public clients and per-service read scopes, not live acceptance
 * or permission for public distribution.
 */
export const GITHUB_REPOSITORY_PERMISSION_NOTICE =
  "Allows read and write access to public and private repositories and related organization resources available to your account. This OAuth App permission does not select individual repositories. Reusing the same app can change permissions returned to other connections; their original access policy is retained.";

const ENTRIES: ReadonlyArray<ConnectorCatalogEntry> = [
  ...GOOGLE_WORKSPACE_SERVICES.map(
    (service): ConnectorCatalogEntry => ({
      id: service.id,
      displayName: `${service.displayName} preview`,
      description: service.description,
      category: "business",
      url: service.resource,
      auth: {
        kind: "sign-in",
        clientSetup: "registered",
        setupGuide: "https://developers.google.com/workspace/guides/create-credentials#desktop-app",
        requestedScopes: service.scopes,
        permissionNotice: `Developer Preview requires an enrolled Workspace account and project. ${service.description} Public distribution requires Google's permission or general availability.`,
      },
    }),
  ),
  {
    id: "slack",
    displayName: "Slack",
    description: "Search public Slack content with an eligible app you register.",
    category: "business",
    url: "https://mcp.slack.com/mcp",
    auth: {
      kind: "sign-in",
      clientSetup: "registered",
      setupGuide: "https://docs.slack.dev/ai/slack-mcp-server/",
      requestedScopes: ["search:read.public"],
    },
  },
  {
    id: "atlassian",
    displayName: "Atlassian",
    description: "Work with permitted Jira, Confluence and other Atlassian Cloud content.",
    category: "business",
    url: "https://mcp.atlassian.com/v2/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "airtable",
    displayName: "Airtable",
    description: "Read and update the bases you select during Airtable consent.",
    category: "business",
    url: "https://mcp.airtable.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "airtable-pat",
    displayName: "Airtable personal token",
    description: "Use a personal token limited to selected bases and read or write permissions.",
    category: "business",
    url: "https://mcp.airtable.com/mcp",
    auth: {
      kind: "key",
      header: "Authorization",
      prefix: "Bearer",
      keyPage: "https://airtable.com/create/tokens",
    },
  },
  {
    id: "hubspot",
    displayName: "HubSpot",
    description: "Read and update CRM data with a connector you register in your HubSpot account.",
    category: "business",
    url: "https://mcp.hubspot.com/",
    auth: {
      kind: "sign-in",
      clientSetup: "registered",
      setupGuide:
        "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
      permissionNotice:
        "Can read and write CRM data allowed by your HubSpot permissions and consent. Available tools depend on your subscription and account configuration. Create your own MCP connector and link its client secret before signing in.",
    },
  },
  {
    id: "linear",
    displayName: "Linear",
    description: "Find, create, and update issues, projects, and comments.",
    category: "popular",
    url: "https://mcp.linear.app/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "notion",
    displayName: "Notion",
    description: "Search, read, and edit pages and databases.",
    category: "popular",
    url: "https://mcp.notion.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "stripe",
    displayName: "Stripe",
    description: "Work with customers, payments, and the Stripe docs.",
    category: "popular",
    url: "https://mcp.stripe.com",
    auth: { kind: "sign-in" },
  },
  {
    id: "sentry",
    displayName: "Sentry",
    description: "Investigate errors, issues, and releases.",
    category: "popular",
    url: "https://mcp.sentry.dev/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "supabase",
    displayName: "Supabase",
    description: "Query Postgres, manage projects, and deploy edge functions.",
    category: "popular",
    url: "https://mcp.supabase.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "vercel",
    displayName: "Vercel",
    description: "Manage projects and deployments, and read deployment logs.",
    category: "popular",
    url: "https://mcp.vercel.com",
    auth: { kind: "sign-in" },
  },
  {
    id: "github-repositories",
    displayName: "GitHub repositories",
    description: "Read and write public and private repositories with your registered OAuth App.",
    category: "developer-tools",
    url: "https://api.githubcopilot.com/mcp/",
    auth: {
      kind: "sign-in",
      clientSetup: "registered",
      setupGuide:
        "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps",
      requestedScopes: ["read:user", "repo", "offline_access"],
      permissionNotice: GITHUB_REPOSITORY_PERMISSION_NOTICE,
    },
  },
  {
    id: "github-oauth",
    displayName: "GitHub OAuth App",
    description:
      "Connect your registered OAuth App with profile read access; tool availability varies.",
    category: "developer-tools",
    url: "https://api.githubcopilot.com/mcp/",
    auth: {
      kind: "sign-in",
      clientSetup: "registered",
      setupGuide:
        "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
      requestedScopes: ["read:user", "offline_access"],
    },
  },
  {
    id: "github",
    displayName: "GitHub",
    description: "Read repositories, issues, and pull requests with a personal access token.",
    category: "popular",
    url: "https://api.githubcopilot.com/mcp/",
    auth: {
      kind: "key",
      header: "Authorization",
      prefix: "Bearer",
      keyPage: "https://github.com/settings/personal-access-tokens",
    },
  },
  {
    id: "figma",
    displayName: "Figma",
    description: "Read files, frames, and design context.",
    category: "popular",
    url: "https://mcp.figma.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "doop",
    displayName: "Doop",
    description: "Build and refine designs on a shared canvas, and open pull requests.",
    category: "popular",
    url: "https://doop.design/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "asana",
    displayName: "Asana",
    description: "Find and update tasks and projects.",
    category: "popular",
    url: "https://mcp.asana.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "todoist",
    displayName: "Todoist",
    description: "Find, add, and complete tasks and projects.",
    category: "popular",
    url: "https://ai.todoist.net/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    description: "Build with Workers, KV, R2, and D1 on your account.",
    category: "developer-tools",
    url: "https://bindings.mcp.cloudflare.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "cloudflare-docs",
    displayName: "Cloudflare docs",
    description: "Search the Cloudflare documentation.",
    category: "developer-tools",
    url: "https://docs.mcp.cloudflare.com/mcp",
    auth: { kind: "none" },
  },
  {
    id: "neon",
    displayName: "Neon",
    description: "Manage serverless Postgres projects and branches.",
    category: "developer-tools",
    url: "https://mcp.neon.tech/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "posthog",
    displayName: "PostHog",
    description: "Query product analytics, feature flags, and errors.",
    category: "developer-tools",
    url: "https://mcp.posthog.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "netlify",
    displayName: "Netlify",
    description: "Create, deploy, and manage Netlify sites.",
    category: "developer-tools",
    url: "https://netlify-mcp.netlify.app/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "prisma",
    displayName: "Prisma",
    description: "Manage Prisma Postgres databases and backups.",
    category: "developer-tools",
    url: "https://mcp.prisma.io/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "railway",
    displayName: "Railway",
    description: "Deploy and manage Railway projects and services.",
    category: "developer-tools",
    url: "https://mcp.railway.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "webflow",
    displayName: "Webflow",
    description: "Read and update sites, pages, and the CMS.",
    category: "developer-tools",
    url: "https://mcp.webflow.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "cloudinary",
    displayName: "Cloudinary",
    description: "Find, upload, and transform media assets.",
    category: "developer-tools",
    url: "https://asset-management.mcp.cloudinary.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "convex",
    displayName: "Convex",
    description: "Start Convex apps and get setup and scaling guidance.",
    category: "developer-tools",
    url: "https://mcp.convex.dev/mcp",
    auth: { kind: "none" },
  },
  {
    id: "context7",
    displayName: "Context7",
    description: "Look up current library documentation and code examples.",
    category: "developer-tools",
    url: "https://mcp.context7.com/mcp",
    auth: { kind: "none" },
  },
  {
    id: "deepwiki",
    displayName: "DeepWiki",
    description: "Ask about public GitHub repositories.",
    category: "developer-tools",
    url: "https://mcp.deepwiki.com/mcp",
    auth: { kind: "none" },
  },
  {
    id: "microsoft-learn",
    displayName: "Microsoft Learn",
    description: "Search Microsoft and Azure documentation.",
    category: "developer-tools",
    url: "https://learn.microsoft.com/api/mcp",
    auth: { kind: "none" },
  },
  {
    id: "hugging-face",
    displayName: "Hugging Face",
    description: "Search models, datasets, Spaces, and papers.",
    category: "developer-tools",
    url: "https://huggingface.co/mcp",
    auth: { kind: "none" },
  },
  {
    id: "paypal",
    displayName: "PayPal",
    description: "Work with invoices, orders, and subscriptions.",
    category: "business",
    url: "https://mcp.paypal.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "square",
    displayName: "Square",
    description: "Work with catalog, orders, payments, and customers.",
    category: "business",
    url: "https://mcp.squareup.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "zapier",
    displayName: "Zapier",
    description: "Run actions across the apps connected to your Zapier account.",
    category: "business",
    url: "https://mcp.zapier.com/api/mcp/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "intercom",
    displayName: "Intercom",
    description: "Search conversations, contacts, and articles.",
    category: "business",
    url: "https://mcp.intercom.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "canva",
    displayName: "Canva",
    description: "Find, create, and export designs.",
    category: "business",
    url: "https://mcp.canva.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "mercado-pago",
    displayName: "Mercado Pago",
    description: "Work with payments and the Mercado Pago docs.",
    category: "business",
    url: "https://mcp.mercadopago.com/mcp",
    auth: { kind: "sign-in" },
  },
];

/**
 * The package name a connector's server is added under. It is reserved: the
 * host refuses a hand-added server this name, so a package carrying it is the
 * catalog connector and nothing a person merely called by the same words.
 */
export function connectorPackageName(id: string): string {
  return `connector-${id}`;
}

export const CONNECTOR_PACKAGE_PREFIX = "connector-";

export function connectorById(id: string): ConnectorCatalogEntry | undefined {
  return ENTRIES.find((entry) => entry.id === id);
}

export function connectorCatalog(): ReadonlyArray<ConnectorCatalogEntry> {
  return ENTRIES;
}

/**
 * The hand-picked set the Library leads with: the services most agent work
 * reaches for (code hosting, issues, notes, errors), one that needs no
 * sign-in so a first connect is a single click, and Doop. Picked from this
 * bundled list, so it shows with no network.
 */
const FEATURED_IDS: ReadonlyArray<string> = [
  "github",
  "linear",
  "notion",
  "sentry",
  "context7",
  "doop",
];

export function featuredConnectors(): ReadonlyArray<ConnectorCatalogEntry> {
  return FEATURED_IDS.flatMap((id) => {
    const entry = connectorById(id);
    return entry === undefined ? [] : [entry];
  });
}

/** Entries whose name or description contains the query, in catalog order; an empty query lists all. */
export function searchConnectorCatalog(query: string): ReadonlyArray<ConnectorCatalogEntry> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return ENTRIES;
  return ENTRIES.filter(
    (entry) =>
      entry.displayName.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle),
  );
}
