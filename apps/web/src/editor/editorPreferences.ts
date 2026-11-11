export interface EditorPreferences {
  readonly wordWrap: "on" | "off";
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  readonly renderWhitespace: "none" | "all";
  readonly minimap: boolean;
  readonly formatOnSave: boolean;
}

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  wordWrap: "off",
  tabSize: 2,
  insertSpaces: true,
  renderWhitespace: "none",
  minimap: false,
  formatOnSave: false,
};
const KEY = "octant.editor-preferences.v1";
export function readEditorPreferences(): EditorPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof value !== "object" || value === null) return DEFAULT_EDITOR_PREFERENCES;
    return {
      wordWrap: "wordWrap" in value && value.wordWrap === "on" ? "on" : "off",
      tabSize:
        "tabSize" in value && [2, 4, 8].includes(Number(value.tabSize)) ? Number(value.tabSize) : 2,
      insertSpaces: !("insertSpaces" in value && value.insertSpaces === false),
      renderWhitespace:
        "renderWhitespace" in value && value.renderWhitespace === "all" ? "all" : "none",
      minimap: "minimap" in value && value.minimap === true,
      formatOnSave: "formatOnSave" in value && value.formatOnSave === true,
    };
  } catch {
    return DEFAULT_EDITOR_PREFERENCES;
  }
}
export function writeEditorPreferences(value: EditorPreferences): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
    window.dispatchEvent(new Event("octant-editor-preferences"));
    return true;
  } catch {
    return false;
  }
}

export function subscribeEditorPreferences(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener("octant-editor-preferences", listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("octant-editor-preferences", listener);
    window.removeEventListener("storage", onStorage);
  };
}
