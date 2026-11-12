// Node 25 and later define their own `localStorage` and `sessionStorage` on the
// global object. Without `--localstorage-file` they read as `undefined`, and
// they shadow the jsdom window's working storage that vitest would otherwise
// expose. Point both names back at jsdom's so every Node version gives each
// test the same isolated storage. This runs before any module that reads
// storage when it is first imported, so testSetup imports it first.
const jsdomWindow: unknown = Reflect.get(globalThis, "jsdom")?.window;
for (const name of ["localStorage", "sessionStorage"] as const) {
  const storage: unknown =
    typeof jsdomWindow === "object" && jsdomWindow !== null
      ? Reflect.get(jsdomWindow, name)
      : undefined;
  if (storage !== undefined) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: storage });
  }
}
export {};
