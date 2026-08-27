/**
 * Typed server port for the Integration plugin kind.
 *
 * Integration plugins run inside the host process and receive only the host
 * ports their declared capabilities allow. These types are the wire contract
 * between a plugin's runtime and the host.
 */
export * from "@octant/contracts/integration";
