import type { CanvasDesignBrand } from "@octant/contracts/canvas";
import { designSystemInstructions } from "@octant/domain/design-system-policy";
import type { DesignSystemFiles, DesignSystemFolders } from "./designSystemFiles";

/** The key a turn's copy of the design system is held under, so only a changed file is sent again. */
export const DESIGN_SYSTEM_CONTEXT_KEY = "project-design-system";

/**
 * How much of the design system a turn carries. A design system that grew
 * past this is cut and the agent told to read the rest from the file, which
 * every Work and Code turn can do.
 */
export const MAX_DESIGN_SYSTEM_CONTEXT_CHARACTERS = 16_000;

export interface DesignSystemTurnContext {
  /** Octant's rule for following the design system: standing, byte-stable. */
  readonly instructions: string;
  /** The primary design system's text, keyed, when the Project has one. */
  readonly system?: { readonly key: string; readonly text: string };
}

/**
 * What a Work or Code turn is told about the Project's design systems, or
 * undefined when the Project has none. Read from the folder on every turn, so
 * an edit made in Octant, in an editor, or by an agent reaches the next turn.
 */
export async function designSystemTurnContext(
  files: Pick<DesignSystemFiles, "primary">,
  folders: DesignSystemFolders,
): Promise<DesignSystemTurnContext | undefined> {
  let found;
  try {
    found = await files.primary(folders);
  } catch {
    return undefined;
  }
  if (found.document === undefined && found.others.length === 0) return undefined;
  const primary =
    found.document === undefined
      ? undefined
      : { folder: found.document.folder, path: found.document.path };
  const instructions = designSystemInstructions({
    primary,
    others: found.others,
    mainFolder: folders.main,
  });
  if (found.document === undefined) return { instructions };
  const where =
    found.document.folder === folders.main
      ? found.document.path
      : `${found.document.folder}/${found.document.path}`;
  const full = found.document.text;
  const text =
    full.length <= MAX_DESIGN_SYSTEM_CONTEXT_CHARACTERS
      ? full
      : `${full.slice(0, MAX_DESIGN_SYSTEM_CONTEXT_CHARACTERS)}\n\n[Cut here: the design system continues in ${where}. Read the file for the rest.]`;
  return {
    instructions,
    system: { key: DESIGN_SYSTEM_CONTEXT_KEY, text: `Contents of ${where}:\n\n${text}` },
  };
}

/**
 * The brand Canvas designs draw with for a Project: its design system's
 * tokens when the primary `DESIGN.md` carries any, so code and documents
 * share one palette; otherwise the brand kit kept on the Project record.
 */
export async function projectCanvasBrand(input: {
  readonly files: Pick<DesignSystemFiles, "primary">;
  readonly folders: DesignSystemFolders | undefined;
  readonly brandKit: CanvasDesignBrand | undefined;
}): Promise<
  | {
      readonly source: "design-system";
      readonly brand: CanvasDesignBrand;
      readonly path: string;
      readonly name: string;
    }
  | { readonly source: "brand-kit"; readonly brand: CanvasDesignBrand }
  | undefined
> {
  if (input.folders !== undefined) {
    try {
      const found = await input.files.primary(input.folders);
      const document = found.document;
      if (document !== undefined && Object.keys(document.reading.brand).length > 0) {
        return {
          source: "design-system",
          brand: document.reading.brand,
          path:
            document.folder === input.folders.main
              ? document.path
              : `${document.folder}/${document.path}`,
          name: document.reading.name,
        };
      }
    } catch {
      // A folder that cannot be read falls back to the kit.
    }
  }
  return input.brandKit === undefined || Object.keys(input.brandKit).length === 0
    ? undefined
    : { source: "brand-kit", brand: input.brandKit };
}
