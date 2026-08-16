import type {
  ExtensionComponentId,
  ExtensionPackageManifest,
  ExtensionSource,
  ExtensionSourceReference,
  SourceQualifiedSkillId,
} from "@octant/contracts/extensions";
import {
  decodeExtensionComponentQualifiedId,
  decodeSourceQualifiedSkillId,
} from "@octant/contracts/extensions";
import type { ToolExtensionId } from "@octant/contracts/tool-actions";

function sortedUnique<T extends string>(values: ReadonlyArray<T>): Array<T> {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sourceQualifier(source: ExtensionSource): ExtensionSourceReference | string {
  if (source.kind === "catalog") return `${source.catalogId}~${source.entryId}`;
  return source.sourceRef;
}

export function componentQualifiedId(
  extensionId: ToolExtensionId | string,
  componentId: ExtensionComponentId | string,
) {
  return decodeExtensionComponentQualifiedId(`${extensionId}/${componentId}`);
}

export function sourceQualifiedSkillId(
  source: ExtensionSource,
  skillName: ExtensionComponentId | string,
  digest: ExtensionPackageManifest["digest"],
): SourceQualifiedSkillId {
  return decodeSourceQualifiedSkillId(
    `${source.kind}:${sourceQualifier(source)}:${skillName}:${digest}`,
  );
}

export function normalizeExtensionManifest(
  manifest: ExtensionPackageManifest,
): ExtensionPackageManifest {
  return {
    ...manifest,
    compatibility: {
      ...manifest.compatibility,
      platforms: sortedUnique(manifest.compatibility.platforms),
      modes: sortedUnique(manifest.compatibility.modes),
      providerFamilies: sortedUnique(manifest.compatibility.providerFamilies),
    },
    declaredCapabilities: sortedUnique(manifest.declaredCapabilities),
    components: [...manifest.components]
      .map((component) => ({
        ...component,
        declaredCapabilities: sortedUnique(component.declaredCapabilities),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}
