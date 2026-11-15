// The compose output: one Kotlin file in tokens.mobile.package (or the
// package its path names under kotlin/ or java/). Colours are a data class
// with a light and a dark instance, a staticCompositionLocalOf, a Theme
// composable that picks one with isSystemInDarkTheme(), and an accessor
// object; every other group is a plain object of values in dp, sp and
// milliseconds.
//
// Every declaration says `public` and its type, so the file compiles in a
// module built in Kotlin's explicit API mode as well as in any other.
//
// A Material 3 ColorScheme is written only for the colours whose names are
// exactly a Material slot (primary, onPrimary, surfaceContainerHigh…), so no
// role is guessed. Dynamic colour stays the app's: the schemes are the static
// fallback, and the app's own switch to dynamicLightColorScheme is left as it is.

import { groupRank } from './mobile-tokens.mjs'
import { byteOf, floatText, numberText } from './mobile-units.mjs'

// The colour slots lightColorScheme and darkColorScheme take.
export const MATERIAL_SLOTS = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'inversePrimary',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
  'background', 'onBackground', 'surface', 'onSurface', 'surfaceVariant', 'onSurfaceVariant', 'surfaceTint',
  'inverseSurface', 'inverseOnSurface', 'error', 'onError', 'errorContainer', 'onErrorContainer',
  'outline', 'outlineVariant', 'scrim',
  'surfaceBright', 'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest', 'surfaceContainerLow', 'surfaceContainerLowest', 'surfaceDim',
]

const f = floatText
const n = numberText
const stringLiteral = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`
const doc = (text, pad) => (text ? [`${pad}/** ${text.replace(/\*\//g, '* /').replace(/\n/g, ' ')} */`] : [])

// The package a Kotlin file's path names: what follows kotlin/ or java/ in a source set.
export function packageOfPath(path) {
  const m = /(?:^|\/)src\/[^/]+\/(?:kotlin|java)\/(.+)\/[^/]+\.kt$/.exec(path)
  return m ? m[1].split('/').join('.') : null
}

function color(c, imports) {
  const bytes = [c.a, c.r, c.g, c.b].map(byteOf)
  if (c.space !== 'display-p3' && bytes.every((b) => b !== null)) return `Color(0x${bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')})`
  if (c.space === 'display-p3') {
    imports.add('androidx.compose.ui.graphics.colorspace.ColorSpaces')
    return `Color(red = ${f(c.r)}, green = ${f(c.g)}, blue = ${f(c.b)}, alpha = ${f(c.a)}, colorSpace = ColorSpaces.DisplayP3)`
  }
  return `Color(red = ${f(c.r)}, green = ${f(c.g)}, blue = ${f(c.b)}, alpha = ${f(c.a)})`
}

const unit = (v, u) => `${n(v)}.${u}`
const unitType = (u, imports) => {
  const type = u === 'dp' ? 'Dp' : 'TextUnit'
  imports.add(`androidx.compose.ui.unit.${type}`)
  return type
}

// The Kotlin source, and what was left out: { text, skipped, notes, needs }.
// `needs` names the Compose libraries the file imports from, for the wire step.
export function buildCompose(plan, options, ctx, header) {
  const { entries } = plan
  const skipped = []
  const notes = []
  const ns = options.namespace
  const pkg = options.package ?? packageOfPath(ctx.path)
  if (!pkg) throw new Error(`the compose output ${ctx.path} needs a package: set tokens.mobile.package, or put the file under src/<set>/kotlin/<package path>/`)
  const imports = new Set(['androidx.compose.ui.graphics.Color'])
  const colors = []
  const groups = new Map()
  const add = (group, lines) => groups.set(group, [...(groups.get(group) ?? []), ...lines])
  const pad = '    '
  const needs = { shadow: false, border: false }
  for (const e of entries) {
    const name = e.kotlin
    const v = e.value
    const head = doc(e.t.description, pad)
    if (v.color) {
      colors.push({ e, name, light: color(v.color, imports), dark: color((e.dark ?? v).color, imports) })
      if (v.color.space === 'srgb' && v.color.converted) notes.push(`${e.t.name}: converted from ${v.color.converted} to sRGB`)
      continue
    }
    const typography = e.group === 'Typography'
    if (v.points !== undefined) {
      const u = typography ? options.fontUnit : 'dp'
      imports.add(`androidx.compose.ui.unit.${u}`)
      add(e.group, [...head, `${pad}public val ${name}: ${unitType(u, imports)} = ${unit(v.points, u)}`])
    } else if (v.number !== undefined) add(e.group, [...head, `${pad}public const val ${name}: Float = ${f(v.number)}`])
    else if (v.weight !== undefined) {
      imports.add('androidx.compose.ui.text.font.FontWeight')
      add(e.group, [...head, `${pad}public val ${name}: FontWeight = FontWeight(${Math.round(v.weight)})`])
    } else if (v.family) {
      if (!v.family.system && !v.family.roboto) notes.push(`${e.t.name}: the family ${v.family.name} must be added as a font resource before Compose can use it`)
      add(e.group, [...head, `${pad}public const val ${name}: String = ${stringLiteral(v.family.system || v.family.roboto ? 'default' : v.family.name)}`])
    } else if (v.ms !== undefined) add(e.group, [...head, `${pad}public const val ${name}: Int = ${Math.round(v.ms)}`])
    else if (v.curve) {
      imports.add('androidx.compose.animation.core.CubicBezierEasing')
      add(e.group, [...head, `${pad}public val ${name}: CubicBezierEasing = CubicBezierEasing(${v.curve.map(f).join(', ')})`])
    } else if (v.text) {
      const t = v.text
      for (const i of ['androidx.compose.ui.text.TextStyle', `androidx.compose.ui.unit.${options.fontUnit}`, 'androidx.compose.ui.text.font.FontFamily']) imports.add(i)
      if (t.family && !t.family.system && !t.family.roboto) notes.push(`${e.t.name}: the family ${t.family.name} is written as FontFamily.Default; add it as a font resource and swap it in`)
      const args = [`fontFamily = FontFamily.Default`]
      if (t.weight) {
        imports.add('androidx.compose.ui.text.font.FontWeight')
        args.push(`fontWeight = FontWeight(${Math.round(t.weight)})`)
      }
      args.push(`fontSize = ${unit(t.size, options.fontUnit)}`)
      if (t.lineHeight !== null) args.push(`lineHeight = ${unit(t.lineHeight, options.fontUnit)}`)
      if (t.tracking !== null) args.push(`letterSpacing = ${unit(t.tracking, options.fontUnit)}`)
      add(e.group, [...head, `${pad}public val ${name}: TextStyle = TextStyle(${args.join(', ')})`])
    } else if (v.shadow) {
      needs.shadow = true
      imports.add('androidx.compose.ui.unit.dp')
      if (v.shadow.some((l) => l.inset)) notes.push(`${e.t.name}: an inset shadow is written as a drop shadow; inset is not carried over`)
      add(e.group, [...head, `${pad}public val ${name}: List<${ns}Shadow> = listOf(${v.shadow.map((l) => `${ns}Shadow(color = ${color(l.color, imports)}, blur = ${unit(l.blur, 'dp')}, offsetX = ${unit(l.x, 'dp')}, offsetY = ${unit(l.y, 'dp')}, spread = ${unit(l.spread, 'dp')})`).join(', ')})`])
    } else if (v.border) {
      needs.border = true
      imports.add('androidx.compose.ui.unit.dp')
      if (!['solid', 'dashed'].includes(v.border.style)) notes.push(`${e.t.name}: the stroke style ${v.border.style} is not carried over; it is written as solid`)
      add(e.group, [...head, `${pad}public val ${name}: ${ns}Border = ${ns}Border(width = ${unit(v.border.width, 'dp')}, color = ${color(v.border.color, imports)}, dashed = ${v.border.style === 'dashed'})`])
    } else if (v.gradient) {
      notes.push(`${e.t.name}: a gradient's stops are carried over; its direction is set where it is drawn`)
      add(e.group, [...head, `${pad}public val ${name}: List<Pair<Float, Color>> = listOf(${v.gradient.map((s) => `${f(s.position)} to ${color(s.color, imports)}`).join(', ')})`])
    }
  }
  for (const e of entries) for (const note of e.notes) notes.push(`${e.t.name}: ${note}`)

  const body = []
  if (colors.length > 0) {
    for (const i of ['androidx.compose.runtime.Immutable', 'androidx.compose.runtime.staticCompositionLocalOf', 'androidx.compose.runtime.ProvidableCompositionLocal', 'androidx.compose.runtime.Composable', 'androidx.compose.runtime.ReadOnlyComposable', 'androidx.compose.runtime.CompositionLocalProvider', 'androidx.compose.foundation.isSystemInDarkTheme']) imports.add(i)
    body.push('@Immutable', `public data class ${ns}Colors(`, ...colors.map((c) => `${pad}public val ${c.name}: Color,`), ')', '')
    for (const [which, key] of [['Light', 'light'], ['Dark', 'dark']]) {
      body.push(`public val ${which}${ns}Colors: ${ns}Colors = ${ns}Colors(`, ...colors.map((c) => `${pad}${c.name} = ${c[key]},`), ')', '')
    }
    body.push(`public val Local${ns}Colors: ProvidableCompositionLocal<${ns}Colors> = staticCompositionLocalOf { Light${ns}Colors }`, '')
    const slots = colors.filter((c) => MATERIAL_SLOTS.includes(c.name))
    if (slots.length > 0) {
      for (const i of ['androidx.compose.material3.ColorScheme', 'androidx.compose.material3.lightColorScheme', 'androidx.compose.material3.darkColorScheme']) imports.add(i)
      body.push(`// The colours whose names are Material 3 slots, as colour schemes. Slots not listed keep Material's own.`)
      for (const [which, fn, key] of [['Light', 'lightColorScheme', 'light'], ['Dark', 'darkColorScheme', 'dark']]) {
        body.push(`public val ${which}${ns}ColorScheme: ColorScheme = ${fn}(`, ...slots.map((c) => `${pad}${c.name} = ${c[key]},`), ')', '')
      }
    }
  }
  const order = [...groups.keys()].sort((a, b) => groupRank(a) - groupRank(b) || (a < b ? -1 : a > b ? 1 : 0))
  for (const group of order) body.push(`public object ${ns}${group} {`, ...groups.get(group), '}', '')
  if (needs.shadow) {
    imports.add('androidx.compose.ui.unit.Dp')
    body.push('/** One shadow layer, as CSS describes it; Compose draws it with Modifier.dropShadow or Modifier.shadow. */', `public data class ${ns}Shadow(public val color: Color, public val blur: Dp, public val offsetX: Dp, public val offsetY: Dp, public val spread: Dp)`, '')
  }
  if (needs.border) {
    imports.add('androidx.compose.ui.unit.Dp')
    body.push(`public data class ${ns}Border(public val width: Dp, public val color: Color, public val dashed: Boolean)`, '')
  }
  body.push(`public object ${ns} {`)
  if (colors.length > 0) body.push(`${pad}public val colors: ${ns}Colors`, `${pad}${pad}@Composable`, `${pad}${pad}@ReadOnlyComposable`, `${pad}${pad}get() = Local${ns}Colors.current`)
  for (const group of order) body.push(`${pad}public val ${group.charAt(0).toLowerCase()}${group.slice(1)}: ${ns}${group} = ${ns}${group}`)
  body.push('}')
  if (colors.length > 0) {
    body.push('', `/** Provides the light or dark colours to everything inside it. Material's own theme stays the app's. */`, '@Composable', `public fun ${ns}Theme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {`, `${pad}CompositionLocalProvider(Local${ns}Colors provides if (darkTheme) Dark${ns}Colors else Light${ns}Colors, content = content)`, '}')
  }
  const sorted = [...imports].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const libraries = [...new Set(sorted.map((i) => i.split('.').slice(0, 3).join('.')))]
  const text = [`// ${header}`, '// massimo mobile output, format 1', '', `package ${pkg}`, '', ...sorted.map((i) => `import ${i}`), '', ...body, ''].join('\n')
  return { text, skipped, notes, libraries }
}
