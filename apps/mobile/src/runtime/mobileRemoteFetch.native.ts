/** The session bridge supplies the cookie bound to each device proof itself. */
export const mobileRemoteFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, {
    ...init,
    // Expo's iOS cookie jar otherwise adds another session cookie, so the host
    // refuses even a correctly signed request after successful authentication.
    credentials: "omit",
    redirect: "error",
  });
