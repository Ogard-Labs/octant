const MAX_MANIFEST_BYTES = 262_144;
const MAX_COMPONENTS = 4_096;
const HEX_256 = /^[0-9a-f]{64}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export const HEADLESS_ARTIFACT_MANIFEST_FILENAME = "octant-artifact.json";

export type HeadlessArtifactPlatform = "darwin" | "linux";
export type HeadlessArtifactArch = "arm64" | "x64";

/** Supported build targets: macOS Apple Silicon plus Linux x64/arm64. */
const SUPPORTED_TARGETS: ReadonlyArray<HeadlessArtifactTarget> = [
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
];

export interface HeadlessArtifactTarget {
  readonly platform: HeadlessArtifactPlatform;
  readonly arch: HeadlessArtifactArch;
}

export type HeadlessArtifactComponentRole =
  | "server"
  | "cli"
  | "web-assets"
  | "native-module"
  | "migrations"
  | "notices"
  | "service-template";

const COMPONENT_ROLES = new Set<HeadlessArtifactComponentRole>([
  "server",
  "cli",
  "web-assets",
  "native-module",
  "migrations",
  "notices",
  "service-template",
]);

/** Roles whose embedded component must be version-matched to the artifact. */
const VERSIONED_ROLES = new Set<HeadlessArtifactComponentRole>(["server", "cli", "web-assets"]);

export interface HeadlessArtifactComponent {
  readonly role: HeadlessArtifactComponentRole;
  /** Artifact-relative path; never absolute and never escaping the root. */
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly version?: string;
}

export interface HeadlessArtifactManifest {
  readonly schemaVersion: 1;
  readonly product: "octant";
  readonly artifactVersion: string;
  readonly target: HeadlessArtifactTarget;
  readonly wireVersion: string;
  readonly storeVersion: number;
  readonly components: ReadonlyArray<HeadlessArtifactComponent>;
}

export class HeadlessArtifactManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadlessArtifactManifestError";
  }
}

export function encodeHeadlessArtifactManifest(manifest: HeadlessArtifactManifest): string {
  validateManifest(manifest);
  return `${JSON.stringify(normalizeManifest(manifest), null, 2)}\n`;
}

export function decodeHeadlessArtifactManifest(input: string): HeadlessArtifactManifest {
  if (Buffer.byteLength(input) > MAX_MANIFEST_BYTES) {
    throw new HeadlessArtifactManifestError("Octant artifact manifest exceeds the size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new HeadlessArtifactManifestError("Octant artifact manifest is not valid JSON.");
  }
  validateManifest(value);
  return Object.freeze(normalizeManifest(value));
}

function normalizeManifest(value: HeadlessArtifactManifest): HeadlessArtifactManifest {
  return {
    schemaVersion: 1,
    product: "octant",
    artifactVersion: value.artifactVersion,
    target: Object.freeze({ platform: value.target.platform, arch: value.target.arch }),
    wireVersion: value.wireVersion,
    storeVersion: value.storeVersion,
    components: Object.freeze(
      value.components.map((component) =>
        Object.freeze({
          role: component.role,
          path: component.path,
          sha256: component.sha256,
          byteLength: component.byteLength,
          ...(component.version === undefined ? {} : { version: component.version }),
        }),
      ),
    ),
  };
}

function validateManifest(value: unknown): asserts value is HeadlessArtifactManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const manifest = value as Record<string, unknown>;
  const expectedKeys = [
    "artifactVersion",
    "components",
    "product",
    "schemaVersion",
    "storeVersion",
    "target",
    "wireVersion",
  ];
  if (Object.keys(manifest).sort().join("\0") !== expectedKeys.join("\0")) invalid();
  if (manifest.schemaVersion !== 1) invalid();
  if (manifest.product !== "octant") invalid();
  if (!boundedString(manifest.artifactVersion, 64)) invalid();
  validateTarget(manifest.target);
  if (!boundedString(manifest.wireVersion, 64)) invalid();
  if (!Number.isSafeInteger(manifest.storeVersion) || (manifest.storeVersion as number) < 0) {
    invalid();
  }
  if (!Array.isArray(manifest.components) || manifest.components.length > MAX_COMPONENTS) {
    invalid();
  }
  const seenPaths = new Set<string>();
  const seenRoles = new Set<HeadlessArtifactComponentRole>();
  for (const component of manifest.components) {
    validateComponent(component);
    if (seenPaths.has(component.path)) invalid();
    seenPaths.add(component.path);
    seenRoles.add(component.role);
  }
  for (const role of COMPONENT_ROLES) {
    if (!seenRoles.has(role)) invalid();
  }
}

function validateTarget(value: unknown): asserts value is HeadlessArtifactTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const target = value as Record<string, unknown>;
  if (Object.keys(target).sort().join("\0") !== "arch\0platform") invalid();
  if (
    !SUPPORTED_TARGETS.some(
      (supported) => supported.platform === target.platform && supported.arch === target.arch,
    )
  ) {
    invalid();
  }
}

function validateComponent(value: unknown): asserts value is HeadlessArtifactComponent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const component = value as Record<string, unknown>;
  const keys = Object.keys(component).sort().join("\0");
  if (
    keys !== "byteLength\0path\0role\0sha256" &&
    keys !== "byteLength\0path\0role\0sha256\0version"
  ) {
    invalid();
  }
  if (!COMPONENT_ROLES.has(component.role as HeadlessArtifactComponentRole)) invalid();
  validateComponentPath(component.path);
  if (typeof component.sha256 !== "string" || !HEX_256.test(component.sha256)) invalid();
  if (!Number.isSafeInteger(component.byteLength) || (component.byteLength as number) < 0) {
    invalid();
  }
  const requiresVersion = VERSIONED_ROLES.has(component.role as HeadlessArtifactComponentRole);
  if (requiresVersion && !boundedString(component.version, 64)) invalid();
  if (
    !requiresVersion &&
    component.version !== undefined &&
    !boundedString(component.version, 64)
  ) {
    invalid();
  }
}

function validateComponentPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) invalid();
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) invalid();
  const segments = value.split("/");
  for (const segment of segments) {
    if (!SAFE_PATH_SEGMENT.test(segment) || segment === "." || segment === "..") invalid();
  }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function invalid(): never {
  throw new HeadlessArtifactManifestError("Octant artifact manifest is malformed or incompatible.");
}
