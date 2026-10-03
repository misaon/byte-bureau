/**
 * Adds JSON Schema definitions under their names.
 * A name names one definition: a different one under a name already taken throws instead of replacing it.
 * @param defs The definitions so far, extended in place.
 * @param added The definitions to add.
 */
export function addDefinitions(
  defs: Record<string, unknown>,
  added: Readonly<Record<string, unknown>>,
): void {
  for (const [name, definition] of Object.entries(added)) {
    if (Object.hasOwn(defs, name) && JSON.stringify(defs[name]) !== JSON.stringify(definition)) {
      throw new Error(`two different JSON Schema definitions are named ${name}`)
    }
    defs[name] = definition
  }
}
