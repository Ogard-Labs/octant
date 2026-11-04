import type { DesktopIdentity } from "@octant/host-runtime";

/** Until the typed client bridge exists, the host-owning module must never load in Nightly. */
export async function launchDesktopApplication(
  identity: DesktopIdentity,
  loadHostOwningDesktop: () => Promise<unknown>,
): Promise<
  | { readonly kind: "started" }
  | { readonly kind: "client-bridge-required"; readonly message: string }
> {
  if (!identity.mayStartHost) {
    return {
      kind: "client-bridge-required",
      message:
        "Needs a newer Octant. The stable desktop client bridge is not available in this build of Octant Nightly.",
    };
  }
  await loadHostOwningDesktop();
  return { kind: "started" };
}
