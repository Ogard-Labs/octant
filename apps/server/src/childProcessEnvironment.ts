const INTERNAL_AUTHORITY_ENVIRONMENT_VARIABLES = [
  "OCTANT_BROWSER_BROKER_URL",
  "OCTANT_BROWSER_BROKER_TOKEN",
  "OCTANT_CREDENTIAL_BROKER_URL",
  "OCTANT_CREDENTIAL_BROKER_TOKEN",
  "OCTANT_DESKTOP_BRIDGE_SECRET",
] as const;

export function childProcessEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...inheritedEnvironment };
  for (const name of INTERNAL_AUTHORITY_ENVIRONMENT_VARIABLES) delete environment[name];
  return environment;
}
