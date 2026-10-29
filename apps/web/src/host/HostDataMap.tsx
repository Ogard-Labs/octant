import type {
  HostDataMap,
  HostDataMapCredentials,
  HostDataMapLocation,
  HostDataMapNamedLocation,
  HostDataMapOutboundCategory,
  HostDataMapProject,
} from "@octant/contracts/host-data-map";
import { SettingsFactList, SettingsPanel, SettingsState } from "../settings/primitives";

const UNKNOWN = "unknown";

const CATEGORY_LABELS: Readonly<Record<HostDataMapOutboundCategory["category"], string>> = {
  "provider-calls": "Provider calls",
  "update-checks": "Update checks",
  "marketplace-fetches": "Marketplace fetches",
};

const PROJECT_TYPE_LABELS: Readonly<Record<HostDataMapProject["type"], string>> = {
  chat: "Chat",
  work: "Work",
  code: "Code",
};

export interface HostDataMapViewProps {
  readonly report: HostDataMap;
}

/**
 * Read-only map of what this host stores and where. Renders server facts only:
 * a category the host could not verify is shown as unknown, never filled in.
 */
export function HostDataMapView({ report }: HostDataMapViewProps) {
  return (
    <div className="host-data-map" data-setting-id="data-map" id="settings-data-map">
      <SettingsPanel
        title="Data map"
        description="What this host stores, and where. Names and locations only — never secrets. This view is read-only."
      >
        <HostFacts report={report} />
      </SettingsPanel>
      <ProjectList report={report} />
      <RelatedActions report={report} />
    </div>
  );
}

function HostFacts({ report }: { readonly report: HostDataMap }) {
  const host = report.host;
  return (
    <div className="settings-panel__stack">
      <SettingsFactList
        facts={[
          { label: "Host", value: host.displayName },
          {
            label: "Kind",
            value: host.kind === "headless" ? "Headless host" : "Desktop app",
          },
          { label: "Journal", value: locationText(host.journal) },
          { label: "Projections", value: locationText(host.projections) },
          { label: "Credentials", value: credentialsText(host.credentials) },
        ]}
      />
      <NamedLocationList heading="Artifacts" entries={host.artifacts} />
      <NamedLocationList heading="Caches" entries={host.caches} />
      <OutboundList categories={host.outbound} />
    </div>
  );
}

function ProjectList({ report }: { readonly report: HostDataMap }) {
  if (report.projects.kind === "unknown") {
    return (
      <SettingsPanel title="Projects" description="Storage that belongs to a Project on this host.">
        <SettingsState kind="empty">{UNKNOWN}</SettingsState>
      </SettingsPanel>
    );
  }
  if (report.projects.projects.length === 0) {
    return (
      <SettingsPanel title="Projects" description="Storage that belongs to a Project on this host.">
        <SettingsState kind="empty">No Projects on this host.</SettingsState>
      </SettingsPanel>
    );
  }
  return (
    <>
      {report.projects.projects.map((project) => (
        <SettingsPanel
          key={String(project.projectId)}
          title={project.name}
          description={`${PROJECT_TYPE_LABELS[project.type]} Project.`}
        >
          <ProjectFacts project={project} />
        </SettingsPanel>
      ))}
    </>
  );
}

function ProjectFacts({ project }: { readonly project: HostDataMapProject }) {
  const facts: Array<{ readonly label: string; readonly value: string }> = [
    { label: "Journal", value: locationText(project.journal) },
    { label: "Projections", value: locationText(project.projections) },
    { label: "Credentials", value: credentialsText(project.credentials) },
  ];
  if (project.boundRoot !== undefined) {
    facts.push({ label: "Bound folder", value: locationText(project.boundRoot) });
  }
  return (
    <div className="settings-panel__stack">
      <SettingsFactList facts={facts} />
      <NamedLocationList heading="Artifacts" entries={project.artifacts} />
      <NamedLocationList heading="Caches" entries={project.caches} />
    </div>
  );
}

function RelatedActions({ report }: { readonly report: HostDataMap }) {
  return (
    <SettingsPanel
      title="Purge and export"
      description="This map does not delete or export anything. Those actions live on their existing surfaces."
    >
      <ul className="host-data-map__related">
        {report.related.map((action) =>
          action.kind === "thread-retention" ? (
            <li key={action.kind}>
              <a href="#settings-thread-retention">Thread retention and purge</a>
            </li>
          ) : (
            <li key={action.kind}>{action.guidance}</li>
          ),
        )}
      </ul>
    </SettingsPanel>
  );
}

function NamedLocationList(props: {
  readonly heading: string;
  readonly entries: ReadonlyArray<HostDataMapNamedLocation>;
}) {
  if (props.entries.length === 0) return null;
  return (
    <div>
      <h3 className="host-data-map__subheading">{props.heading}</h3>
      <SettingsFactList
        facts={props.entries.map((entry) => ({
          label: entry.name,
          value: locationText(entry.location),
        }))}
      />
    </div>
  );
}

function OutboundList(props: { readonly categories: ReadonlyArray<HostDataMapOutboundCategory> }) {
  return (
    <div>
      <h3 className="host-data-map__subheading">What leaves this machine</h3>
      <SettingsFactList
        facts={props.categories.map((category) => ({
          label: CATEGORY_LABELS[category.category],
          value: outboundText(category),
        }))}
      />
    </div>
  );
}

function locationText(location: HostDataMapLocation): string {
  return location.kind === "known" ? location.path : UNKNOWN;
}

function credentialsText(credentials: HostDataMapCredentials): string {
  if (credentials.kind === "unknown") return UNKNOWN;
  const backend = credentials.backend === "keychain" ? "Keychain" : "secret-service";
  if (credentials.entries.length === 0) return backend;
  return `${backend}: ${credentials.entries.map((entry) => entry.service).join(", ")}`;
}

function outboundText(category: HostDataMapOutboundCategory): string {
  if (category.kind === "unknown") return UNKNOWN;
  return category.leavesMachine
    ? `Leaves this machine. ${category.purpose}`
    : `Does not leave this machine. ${category.purpose}`;
}
