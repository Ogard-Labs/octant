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
  /** Other words a person may search for: products it covers and the kind of tool it is. */
  readonly keywords?: readonly string[];
  readonly url: string;
  /** The vendor's own page on connecting to this server, shown beside the entry. */
  readonly docs: string;
  readonly auth: ConnectorAuth;
}

export const CONNECTOR_CATEGORY_LABEL: Readonly<Record<ConnectorCategory, string>> = {
  popular: "Popular",
  "developer-tools": "Developer tools",
  business: "Business",
};

/**
 * Entries were probed on 2026-10-20 (Doop on 2026-11-01; Dropbox, monday.com,
 * ClickUp, Miro, GitLab, Buildkite, Amplitude, Calendly, Pipedrive, Klaviyo and
 * Box on 2026-11-07): each sign-in server answered a bare
 * request with 401 and resource metadata, its authorization server published
 * metadata with PKCE S256 and dynamic client registration; each key server
 * answered 401 without registration; each open server answered without a
 * credential. An address that stops behaving that way belongs out, not fixed
 * up in the UI. Slack is separately documented on 2026-11-02: its exact dedicated
 * metadata requires a person-owned registered confidential client and a single
 * public-search scope; no live registration/consent/tool acceptance is claimed.
 * Google entries are Developer Preview: the 2026-11-03 documentation establishes
 * agentic Desktop public clients and per-service read scopes, not live acceptance
 * or permission for public distribution. Box's resource metadata names an
 * authorization server with PKCE S256 and client-secret token authentication
 * but no dynamic registration, so it needs the admin-enabled integration's own
 * client; no live consent or tool acceptance is claimed.
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
      docs: "https://developers.google.com/workspace/guides/create-credentials#desktop-app",
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
    keywords: ["chat", "messages", "channels"],
    url: "https://mcp.slack.com/mcp",
    docs: "https://docs.slack.dev/ai/slack-mcp-server/",
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
    keywords: ["jira", "confluence", "issues", "wiki"],
    url: "https://mcp.atlassian.com/v2/mcp",
    docs: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    auth: { kind: "sign-in" },
  },
  {
    id: "airtable",
    displayName: "Airtable",
    description: "Read and update the bases you select during Airtable consent.",
    category: "business",
    keywords: ["database", "spreadsheet", "bases"],
    url: "https://mcp.airtable.com/mcp",
    docs: "https://support.airtable.com/docs/using-the-airtable-mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "airtable-pat",
    displayName: "Airtable personal token",
    description: "Use a personal token limited to selected bases and read or write permissions.",
    category: "business",
    keywords: ["database", "spreadsheet", "bases"],
    url: "https://mcp.airtable.com/mcp",
    docs: "https://support.airtable.com/docs/using-the-airtable-mcp-server",
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
    keywords: ["crm", "sales", "marketing", "contacts"],
    url: "https://mcp.hubspot.com/",
    docs: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
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
    keywords: ["issues", "tickets", "project management"],
    url: "https://mcp.linear.app/mcp",
    docs: "https://linear.app/docs/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "notion",
    displayName: "Notion",
    description: "Search, read, and edit pages and databases.",
    category: "popular",
    keywords: ["wiki", "docs", "notes"],
    url: "https://mcp.notion.com/mcp",
    docs: "https://developers.notion.com/docs/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "stripe",
    displayName: "Stripe",
    description: "Work with customers, payments, and the Stripe docs.",
    category: "popular",
    keywords: ["payments", "billing", "subscriptions"],
    url: "https://mcp.stripe.com",
    docs: "https://docs.stripe.com/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "sentry",
    displayName: "Sentry",
    description: "Investigate errors, issues, and releases.",
    category: "popular",
    keywords: ["errors", "monitoring", "crashes"],
    url: "https://mcp.sentry.dev/mcp",
    docs: "https://docs.sentry.io/product/sentry-mcp/",
    auth: { kind: "sign-in" },
  },
  {
    id: "supabase",
    displayName: "Supabase",
    description: "Query Postgres, manage projects, and deploy edge functions.",
    category: "popular",
    keywords: ["database", "auth", "storage"],
    url: "https://mcp.supabase.com/mcp",
    docs: "https://supabase.com/docs/guides/getting-started/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "vercel",
    displayName: "Vercel",
    description: "Manage projects and deployments, and read deployment logs.",
    category: "popular",
    keywords: ["hosting", "deploy", "next.js"],
    url: "https://mcp.vercel.com",
    docs: "https://vercel.com/docs/mcp/vercel-mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "github-repositories",
    displayName: "GitHub repositories",
    description: "Read and write public and private repositories with your registered OAuth App.",
    category: "developer-tools",
    keywords: ["git", "code", "pull requests"],
    url: "https://api.githubcopilot.com/mcp/",
    docs: "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server",
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
    keywords: ["git", "code"],
    url: "https://api.githubcopilot.com/mcp/",
    docs: "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server",
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
    keywords: ["git", "code", "issues"],
    url: "https://api.githubcopilot.com/mcp/",
    docs: "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server",
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
    keywords: ["design", "ui", "prototypes"],
    url: "https://mcp.figma.com/mcp",
    docs: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    auth: { kind: "sign-in" },
  },
  {
    id: "doop",
    displayName: "Doop",
    description: "Build and refine designs on a shared canvas, and open pull requests.",
    category: "popular",
    keywords: ["design", "canvas", "prototypes"],
    url: "https://doop.design/mcp",
    docs: "https://doop.design/docs/get-started",
    auth: { kind: "sign-in" },
  },
  {
    id: "asana",
    displayName: "Asana",
    description: "Find and update tasks and projects.",
    category: "popular",
    keywords: ["tasks", "project management"],
    url: "https://mcp.asana.com/mcp",
    docs: "https://developers.asana.com/docs/using-asanas-mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "dropbox",
    displayName: "Dropbox",
    description: "Search, read, and organize files and folders, and work with shared links.",
    category: "popular",
    keywords: ["files", "storage", "cloud drive"],
    url: "https://mcp.dropbox.com/mcp",
    docs: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "monday",
    displayName: "monday.com",
    description: "Read and update boards, items, and updates.",
    category: "popular",
    keywords: ["monday", "boards", "project management", "work management"],
    url: "https://mcp.monday.com/mcp",
    docs: "https://developer.monday.com/api-reference/docs/compatible-mcp-clients",
    auth: { kind: "sign-in" },
  },
  {
    id: "clickup",
    displayName: "ClickUp",
    description: "Find and update tasks, docs, comments, and time entries.",
    category: "popular",
    keywords: ["tasks", "project management"],
    url: "https://mcp.clickup.com/mcp",
    docs: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "miro",
    displayName: "Miro",
    description: "Read boards and create diagrams and content on them.",
    category: "popular",
    keywords: ["whiteboard", "diagrams", "boards"],
    url: "https://mcp.miro.com/",
    docs: "https://developers.miro.com/docs/mcp-intro",
    auth: { kind: "sign-in" },
  },
  {
    id: "todoist",
    displayName: "Todoist",
    description: "Find, add, and complete tasks and projects.",
    category: "popular",
    keywords: ["tasks", "to-do", "reminders"],
    url: "https://ai.todoist.net/mcp",
    docs: "https://github.com/Doist/todoist-ai/blob/main/docs/mcp-server.md",
    auth: { kind: "sign-in" },
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    description: "Build with Workers, KV, R2, and D1 on your account.",
    category: "developer-tools",
    keywords: ["workers", "kv", "r2", "d1", "serverless"],
    url: "https://bindings.mcp.cloudflare.com/mcp",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    auth: { kind: "sign-in" },
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    description: "Work with GitLab.com projects, issues, merge requests, and pipelines.",
    category: "developer-tools",
    keywords: ["git", "code", "ci", "merge requests"],
    url: "https://gitlab.com/api/v4/mcp",
    docs: "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/",
    auth: { kind: "sign-in" },
  },
  {
    id: "buildkite",
    displayName: "Buildkite",
    description: "Inspect pipelines, builds, jobs, and logs.",
    category: "developer-tools",
    keywords: ["ci", "builds", "pipelines"],
    url: "https://mcp.buildkite.com/mcp",
    docs: "https://buildkite.com/docs/apis/mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "amplitude",
    displayName: "Amplitude",
    description: "Query product analytics, charts, and experiment results.",
    category: "developer-tools",
    keywords: ["analytics", "events", "experiments"],
    url: "https://mcp.amplitude.com/mcp",
    docs: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "cloudflare-docs",
    displayName: "Cloudflare docs",
    description: "Search the Cloudflare documentation.",
    category: "developer-tools",
    keywords: ["documentation", "workers"],
    url: "https://docs.mcp.cloudflare.com/mcp",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    auth: { kind: "none" },
  },
  {
    id: "neon",
    displayName: "Neon",
    description: "Manage serverless Postgres projects and branches.",
    category: "developer-tools",
    keywords: ["database", "serverless"],
    url: "https://mcp.neon.tech/mcp",
    docs: "https://neon.com/docs/ai/neon-mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "posthog",
    displayName: "PostHog",
    description: "Query product analytics, feature flags, and errors.",
    category: "developer-tools",
    keywords: ["analytics", "feature flags", "session replay"],
    url: "https://mcp.posthog.com/mcp",
    docs: "https://posthog.com/docs/model-context-protocol",
    auth: { kind: "sign-in" },
  },
  {
    id: "netlify",
    displayName: "Netlify",
    description: "Create, deploy, and manage Netlify sites.",
    category: "developer-tools",
    keywords: ["hosting", "deploy"],
    url: "https://netlify-mcp.netlify.app/mcp",
    docs: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
    auth: { kind: "sign-in" },
  },
  {
    id: "prisma",
    displayName: "Prisma",
    description: "Manage Prisma Postgres databases and backups.",
    category: "developer-tools",
    keywords: ["database", "orm"],
    url: "https://mcp.prisma.io/mcp",
    docs: "https://www.prisma.io/docs/postgres/integrations/mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "railway",
    displayName: "Railway",
    description: "Deploy and manage Railway projects and services.",
    category: "developer-tools",
    keywords: ["hosting", "deploy"],
    url: "https://mcp.railway.com/mcp",
    docs: "https://docs.railway.com/ai/mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "webflow",
    displayName: "Webflow",
    description: "Read and update sites, pages, and the CMS.",
    category: "developer-tools",
    keywords: ["website", "cms"],
    url: "https://mcp.webflow.com/mcp",
    docs: "https://developers.webflow.com/data/docs/ai-tools",
    auth: { kind: "sign-in" },
  },
  {
    id: "cloudinary",
    displayName: "Cloudinary",
    description: "Find, upload, and transform media assets.",
    category: "developer-tools",
    keywords: ["images", "video", "media"],
    url: "https://asset-management.mcp.cloudinary.com/mcp",
    docs: "https://cloudinary.com/documentation/cloudinary_llm_mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "convex",
    displayName: "Convex",
    description: "Start Convex apps and get setup and scaling guidance.",
    category: "developer-tools",
    keywords: ["database", "backend"],
    url: "https://mcp.convex.dev/mcp",
    docs: "https://docs.convex.dev/ai/convex-mcp-server",
    auth: { kind: "none" },
  },
  {
    id: "context7",
    displayName: "Context7",
    description: "Look up current library documentation and code examples.",
    category: "developer-tools",
    keywords: ["documentation", "libraries"],
    url: "https://mcp.context7.com/mcp",
    docs: "https://github.com/upstash/context7",
    auth: { kind: "none" },
  },
  {
    id: "deepwiki",
    displayName: "DeepWiki",
    description: "Ask about public GitHub repositories.",
    category: "developer-tools",
    keywords: ["documentation", "github", "repositories"],
    url: "https://mcp.deepwiki.com/mcp",
    docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    auth: { kind: "none" },
  },
  {
    id: "microsoft-learn",
    displayName: "Microsoft Learn",
    description: "Search Microsoft and Azure documentation.",
    category: "developer-tools",
    keywords: ["azure", "microsoft docs", "documentation"],
    url: "https://learn.microsoft.com/api/mcp",
    docs: "https://learn.microsoft.com/en-us/training/support/mcp",
    auth: { kind: "none" },
  },
  {
    id: "hugging-face",
    displayName: "Hugging Face",
    description: "Search models, datasets, Spaces, and papers.",
    category: "developer-tools",
    keywords: ["ai models", "datasets", "machine learning"],
    url: "https://huggingface.co/mcp",
    docs: "https://huggingface.co/docs/hub/hf-mcp-server",
    auth: { kind: "none" },
  },
  {
    id: "paypal",
    displayName: "PayPal",
    description: "Work with invoices, orders, and subscriptions.",
    category: "business",
    keywords: ["payments", "invoices"],
    url: "https://mcp.paypal.com/mcp",
    docs: "https://developer.paypal.com/ai-tools/mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "square",
    displayName: "Square",
    description: "Work with catalog, orders, payments, and customers.",
    category: "business",
    keywords: ["payments", "point of sale"],
    url: "https://mcp.squareup.com/mcp",
    docs: "https://developer.squareup.com/docs/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "zapier",
    displayName: "Zapier",
    description: "Run actions across the apps connected to your Zapier account.",
    category: "business",
    keywords: ["automation", "workflows", "integrations"],
    url: "https://mcp.zapier.com/api/mcp/mcp",
    docs: "https://docs.zapier.com/mcp/home",
    auth: { kind: "sign-in" },
  },
  {
    id: "composio",
    displayName: "Composio",
    description: "Reach Gmail, Google Drive and many other apps through Composio's hosted service.",
    category: "business",
    keywords: ["gmail", "google drive", "google calendar", "email", "aggregator", "integrations"],
    url: "https://connect.composio.dev/mcp",
    docs: "https://docs.composio.dev/docs/composio-connect",
    auth: {
      kind: "sign-in",
      permissionNotice:
        "Composio is a third-party hosted service. It stores the sign-ins you give it for other apps, and the content the agent reads or writes in them passes through its servers, not only between this Mac and the app. Octant does not control how long Composio keeps it.",
    },
  },
  {
    id: "intercom",
    displayName: "Intercom",
    description: "Search conversations, contacts, and articles.",
    category: "business",
    keywords: ["support", "customer messaging", "help desk"],
    url: "https://mcp.intercom.com/mcp",
    docs: "https://developers.intercom.com/docs/guides/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "canva",
    displayName: "Canva",
    description: "Find, create, and export designs.",
    category: "business",
    keywords: ["design", "graphics", "presentations"],
    url: "https://mcp.canva.com/mcp",
    docs: "https://www.canva.dev/docs/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "box",
    displayName: "Box",
    description: "Search, read, and manage Box content with an integration your Box admin enables.",
    category: "business",
    keywords: ["files", "storage", "cloud drive", "documents"],
    url: "https://mcp.box.com/",
    docs: "https://developer.box.com/guides/box-mcp/remote/",
    auth: {
      kind: "sign-in",
      clientSetup: "registered",
      setupGuide: "https://developer.box.com/guides/box-mcp/remote/",
      permissionNotice:
        "Can read and change files and folders your Box account can reach, within the scopes set on the integration. A Box admin enables the Box MCP Server integration; copy its client ID and link its client secret before signing in.",
    },
  },
  {
    id: "calendly",
    displayName: "Calendly",
    description: "See event types and bookings, and share scheduling links.",
    category: "business",
    keywords: ["scheduling", "meetings", "calendar", "booking"],
    url: "https://mcp.calendly.com",
    docs: "https://developer.calendly.com/calendly-mcp-server",
    auth: { kind: "sign-in" },
  },
  {
    id: "pipedrive",
    displayName: "Pipedrive",
    description: "Read and update deals, contacts, leads, and activities.",
    category: "business",
    keywords: ["crm", "sales", "deals"],
    url: "https://mcp.pipedrive.ai/mcp",
    docs: "https://support.pipedrive.com/en/article/mcp",
    auth: { kind: "sign-in" },
  },
  {
    id: "klaviyo",
    displayName: "Klaviyo",
    description: "Work with profiles, lists, campaigns, and flows.",
    category: "business",
    keywords: ["email marketing", "sms", "marketing"],
    url: "https://mcp.klaviyo.com/mcp",
    docs: "https://developers.klaviyo.com/en/docs/connect_to_the_klaviyo_mcp_server",
    auth: { kind: "sign-in" },
  },
  {
    id: "mercado-pago",
    displayName: "Mercado Pago",
    description: "Work with payments and the Mercado Pago docs.",
    category: "business",
    keywords: ["payments"],
    url: "https://mcp.mercadopago.com/mcp",
    docs: "https://www.mercadopago.com/developers/en/docs/mcp-server/overview",
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

/** Entries whose name, description or a keyword contains the query, in catalog order; an empty query lists all. */
export function searchConnectorCatalog(query: string): ReadonlyArray<ConnectorCatalogEntry> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return ENTRIES;
  return ENTRIES.filter(
    (entry) =>
      entry.displayName.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle) ||
      (entry.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle)),
  );
}
