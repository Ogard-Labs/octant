import {
  decodeCodeRepositoryTestDefinition,
  decodeCodeRepositoryTestDefinitionFile,
  type CodeRepositoryTestDefinition,
  type CodeRepositoryTestDefinitionFile,
  type CodeTestDefinitionId,
  type CodeTestPackageManager,
} from "@octant/contracts";

export interface SelectedPackageScript {
  readonly id: CodeTestDefinitionId;
  readonly packagePath: string;
  readonly packageManager: CodeTestPackageManager;
  readonly script: string;
  readonly packageJson: unknown;
  readonly cwd: string;
  readonly environmentRefs: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly artifactPaths: ReadonlyArray<string>;
}

export interface SelectedOctantTestDefinition {
  readonly id: CodeTestDefinitionId;
  readonly selectedId: string;
  readonly file: unknown;
}

export class TestDefinitionServiceError extends Error {
  override readonly name = "TestDefinitionServiceError";
}

/** Package script text is never parsed or executed; the package manager receives structured argv. */
export class TestDefinitionService {
  fromPackageScript(input: SelectedPackageScript): CodeRepositoryTestDefinition {
    if (!hasPackageScript(input.packageJson, input.script)) {
      throw new TestDefinitionServiceError("Selected package script is not available.");
    }
    return decodeDefinition({
      id: input.id,
      name: input.script,
      source: {
        kind: "package-script",
        packagePath: input.packagePath,
        packageManager: input.packageManager,
        script: input.script,
      },
      argv: [input.packageManager, "run", input.script],
      cwd: input.cwd,
      environmentRefs: [...input.environmentRefs],
      timeoutMs: input.timeoutMs,
      artifactPaths: [...input.artifactPaths],
    });
  }

  fromOctantFile(input: SelectedOctantTestDefinition): CodeRepositoryTestDefinition {
    let file: CodeRepositoryTestDefinitionFile;
    try {
      file = decodeCodeRepositoryTestDefinitionFile(input.file);
    } catch {
      throw new TestDefinitionServiceError(".octant/tests.json is invalid.");
    }
    const selected = file.tests.find((test) => test.id === input.selectedId);
    if (selected === undefined) {
      throw new TestDefinitionServiceError("Selected Octant test definition is not available.");
    }
    return decodeDefinition({
      id: input.id,
      name: selected.name,
      source: { kind: "octant-file", path: ".octant/tests.json", selectedId: selected.id },
      argv: [...selected.argv],
      cwd: selected.cwd,
      environmentRefs: [...selected.environmentRefs],
      timeoutMs: selected.timeoutMs,
      artifactPaths: [...selected.artifactPaths],
    });
  }
}

function hasPackageScript(value: unknown, script: string): boolean {
  if (typeof value !== "object" || value === null || !("scripts" in value)) return false;
  const scripts = value.scripts;
  return (
    typeof scripts === "object" &&
    scripts !== null &&
    script in scripts &&
    typeof scripts[script as keyof typeof scripts] === "string"
  );
}

function decodeDefinition(value: unknown): CodeRepositoryTestDefinition {
  try {
    return decodeCodeRepositoryTestDefinition(value);
  } catch {
    throw new TestDefinitionServiceError("Test definition is invalid.");
  }
}
