export type ParsedComposerReference =
  | { readonly kind: "plugin"; readonly pluginSlug: string; readonly componentId?: string }
  | { readonly kind: "skill"; readonly skillName: string }
  | { readonly kind: "plain-text"; readonly text: string };

const pluginReference = /^@([a-z][a-z0-9-]{0,63})(?:\/([a-z][a-z0-9-]{0,63}))?$/;
const skillReference = /^\$([A-Za-z0-9][A-Za-z0-9._~:-]{0,511})$/;

export function parseComposerReference(input: string): ParsedComposerReference {
  const plugin = pluginReference.exec(input);
  if (plugin !== null) {
    const componentId = plugin[2];
    return componentId === undefined
      ? { kind: "plugin", pluginSlug: plugin[1]! }
      : { kind: "plugin", pluginSlug: plugin[1]!, componentId };
  }
  const skill = skillReference.exec(input);
  if (skill !== null) return { kind: "skill", skillName: skill[1]! };
  return { kind: "plain-text", text: input };
}
