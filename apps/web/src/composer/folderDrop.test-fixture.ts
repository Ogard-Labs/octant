export function nativeFolderTransfer() {
  const file = new File([], "日本語 folder", { type: "" });
  return {
    items: [
      { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: true }) },
    ],
    files: [file],
    getData: () => "",
  };
}
