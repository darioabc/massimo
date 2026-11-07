// Read-only: what the Figma file holds, for massimo's mirror. Pass this whole
// script as the code of one use_figma call (load the figma-use skill first),
// save the JSON it returns to <project>/figma/export.json, then run
// `tokens.mjs figma --record` or `--drift` on that file. It changes nothing in
// Figma. Unlike get_variable_defs, which reads one node, it reads every local
// variable in every mode, aliases included, and the local text and effect styles.

const collections = await figma.variables.getLocalVariableCollectionsAsync()
const byId = new Map()
for (const c of collections) {
  for (const id of c.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(id)
    if (v) byId.set(id, { v, c })
  }
}
const round = (n) => Math.round(n * 1e6) / 1e6
const valueOf = (v, raw) => {
  if (raw && raw.type === 'VARIABLE_ALIAS') {
    const target = byId.get(raw.id)
    return target ? { alias: target.v.name, collection: target.c.name } : { alias: raw.id }
  }
  if (v.resolvedType === 'COLOR' && raw) return { r: round(raw.r), g: round(raw.g), b: round(raw.b), a: round(raw.a ?? 1) }
  return raw
}
const out = { collections: [], textStyles: [], effectStyles: [] }
for (const c of collections) {
  const variables = []
  for (const id of c.variableIds) {
    const entry = byId.get(id)
    if (!entry) continue
    const { v } = entry
    const values = {}
    for (const m of c.modes) values[m.name] = valueOf(v, v.valuesByMode[m.modeId])
    variables.push({ id: v.id, name: v.name, type: v.resolvedType, scopes: v.scopes, values, description: v.description, codeSyntax: v.codeSyntax })
  }
  out.collections.push({ id: c.id, name: c.name, modes: c.modes.map((m) => m.name), variables })
}
const boundNames = (bound) =>
  Object.fromEntries(Object.entries(bound ?? {}).map(([field, alias]) => [field, byId.get(alias?.id)?.v.name ?? alias?.id ?? null]))
for (const s of await figma.getLocalTextStylesAsync()) {
  out.textStyles.push({
    id: s.id,
    name: s.name,
    fontFamily: s.fontName.family,
    fontStyle: s.fontName.style,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    boundVariables: boundNames(s.boundVariables),
  })
}
for (const s of await figma.getLocalEffectStylesAsync()) {
  out.effectStyles.push({
    id: s.id,
    name: s.name,
    effects: s.effects.map((e) => ({ type: e.type, color: e.color, offset: e.offset, radius: e.radius, spread: e.spread, boundVariables: boundNames(e.boundVariables) })),
  })
}
return out
