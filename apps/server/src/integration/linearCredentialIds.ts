/**
 * Stable host credential ids for the bundled Linear plugin. They are opaque
 * UUIDs in the Keychain; the plugin only ever sees these as references.
 */
export const LINEAR_OAUTH_CREDENTIAL_ID = "a1000000-0000-4000-8000-0000000000e1";
export const LINEAR_API_KEY_CREDENTIAL_ID = "a1000000-0000-4000-8000-0000000000e2";

export const LINEAR_CREDENTIAL_IDS = {
  oauth: LINEAR_OAUTH_CREDENTIAL_ID,
  "personal-api-key": LINEAR_API_KEY_CREDENTIAL_ID,
} as const;
