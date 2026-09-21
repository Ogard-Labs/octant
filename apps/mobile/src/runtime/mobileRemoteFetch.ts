/** Browser cookies remain browser-owned; device proofs must not follow redirects. */
export const mobileRemoteFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: "error" });
