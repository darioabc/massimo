// The swift output: one Swift file with the tokens under one namespace
// (`DesignTokens` unless tokens.mobile.namespace says otherwise), a nested
// enum per group. SwiftUI first; `tokens.mobile.uikit` adds UIColor and
// UIFont twins.
//
// Colours read an asset catalog by name, so they follow the appearance as
// any catalog colour does: the app's own catalog in catalog mode (the
// default when the app has one), or the catalog the xcassets output writes
// in tokens mode. With no catalog to read, a colour is built from its
// components, with a trait-based provider for dark mode.
//
// Inside a Swift package target, declarations are `public` and catalogs are
// read from `.module`; anywhere else from the bundle that holds this file.
//
// Everything it writes is in SwiftUI's first release (iOS 13, macOS 10.15,
// tvOS 13, watchOS 6), so it compiles whatever floor the target declares;
// what came later (Font.custom relativeTo, the title2 style) is behind
// #available with the closest older form. watchOS has no light and dark
// appearance and no dynamic UIColor, so there a colour built from its
// components takes its light value, as a catalog colour does.
//
// Type follows Dynamic Type: a typography token needs an iOS text style to
// scale with (tokens.mobile.textStyles, or a name such as body or caption).
// Without one, or an explicit "fixed", it is not written, since a fixed size
// would not grow with the user's text size.

import { groupRank } from './mobile-tokens.mjs'
import { numberText, textStyleOf } from './mobile-units.mjs'

const SWIFT_WEIGHTS = [[100, 'ultraLight'], [200, 'thin'], [300, 'light'], [400, 'regular'], [500, 'medium'], [600, 'semibold'], [700, 'bold'], [800, 'heavy'], [900, 'black']]
const weightName = (w) => SWIFT_WEIGHTS.reduce((best, [n, name]) => (Math.abs(n - w) < Math.abs(best[0] - w) ? [n, name] : best))[1]

const n = numberText
const stringLiteral = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
// Swift ends a line comment at a carriage return too, so every line break starts a new /// line.
const doc = (text, pad) => (text ? text.split(/\r\n|\r|\n|\u2028|\u2029/).map((l) => `${pad}/// ${l}`.trimEnd()) : [])

// Font.Design's cases; a generic family with none (cursive) is the system font.
const SWIFT_DESIGNS = ['monospaced', 'serif', 'rounded']
// Text styles added in iOS 14, with the iOS 13 style closest to each.
const LATER_STYLES = { title2: 'title', title3: 'title', caption2: 'caption' }
const LATER = 'iOS 14.0, macOS 11.0, tvOS 14.0, watchOS 7.0, *'
// A font that needs iOS 14, with its iOS 13 form behind #available.
const available = (later, earlier) => (later === earlier ? later : `{ if #available(${LATER}) { return ${later} } else { return ${earlier} } }()`)

function staticColor(c) {
  const a = n(c.a)
  if (c.space === 'display-p3') return `Color(.displayP3, red: ${n(c.r)}, green: ${n(c.g)}, blue: ${n(c.b)}, opacity: ${a})`
  return `Color(.sRGB, red: ${n(c.r)}, green: ${n(c.g)}, blue: ${n(c.b)}, opacity: ${a})`
}

function uiColor(c) {
  if (c.space === 'display-p3') return `UIColor(displayP3Red: ${n(c.r)}, green: ${n(c.g)}, blue: ${n(c.b)}, alpha: ${n(c.a)})`
  return `UIColor(red: ${n(c.r)}, green: ${n(c.g)}, blue: ${n(c.b)}, alpha: ${n(c.a)})`
}

// NSColor(red:green:blue:alpha:) is extended sRGB, so a component outside 0..1 is kept.
function nsColor(c) {
  if (c.space === 'display-p3') return `NSColor(displayP3Red: ${n(c.r)}, green: ${n(c.g)}, blue: ${n(c.b)}, alpha: ${n(c.a)})`
  return `NSColor(red: ${n(c.r)}, green: ${n(c.g)}, blue: ${n(c.b)}, alpha: ${n(c.a)})`
}

// The Swift source, what was left out and what it declares: { text, skipped, notes, names }.
//   ctx.inPackage  whether the file sits in a Swift package target: then
//                  declarations are public and catalogs read from .module
//   ctx.catalog    Map token name -> colour set name the code reads, or null
//                  when colours are built from their components
//   ctx.only       whether every colour must come from ctx.catalog; else a
//                  colour not in it is built from its components
//   ctx.skip       Map token name -> why it is left out, for colours that
//                  can neither be read nor built without losing something
//   ctx.mode       'catalog' or 'tokens', for the notes
export function buildSwift(plan, options, ctx, header) {
  const { entries } = plan
  const skipped = []
  const notes = []
  const ns = options.namespace
  const pub = ctx.inPackage ? 'public ' : ''
  const bundle = ctx.inPackage ? '.module' : `${ns.charAt(0).toLowerCase()}${ns.slice(1)}Bundle`
  let catalogColors = false
  const pad = '        '
  const groups = new Map()
  const add = (group, lines) => groups.set(group, [...(groups.get(group) ?? []), ...lines])
  const needs = { shadow: false, border: false, textStyle: false, uikitColors: [] }
  let traitColors = false
  for (const e of entries) {
    const name = e.swift
    const head = doc(e.t.description, pad)
    const v = e.value
    if (v.color) {
      const left = ctx.skip?.get(e.t.name)
      if (left) {
        skipped.push({ token: e.t.name, why: left })
        continue
      }
      const asset = ctx.catalog ? ctx.catalog.get(e.t.name) ?? null : null
      if (ctx.only && !asset) {
        skipped.push({ token: e.t.name, why: ctx.mode === 'catalog' ? 'is not a colour set in the app\'s catalog, which is the colour source in catalog mode: add it to the catalog, or set tokens.mobile.colors to "tokens"' : 'is not in the catalog the xcassets output writes' })
        continue
      }
      if (asset) {
        catalogColors = true
        add('Colors', [...head, `${pad}${pub}static let ${name} = Color(${stringLiteral(asset)}, bundle: ${bundle})`])
        needs.uikitColors.push({ name, line: `UIColor(named: ${stringLiteral(asset)}, in: ${bundle}, compatibleWith: nil) ?? .clear` })
      } else {
        const dark = e.dark?.color
        if (!dark) {
          add('Colors', [...head, `${pad}${pub}static let ${name} = ${staticColor(v.color)}`])
          needs.uikitColors.push({ name, line: uiColor(v.color) })
          continue
        }
        // A dynamic provider follows the appearance: UIKit's (iOS, tvOS,
        // Mac Catalyst), AppKit's (a macOS target of the same package).
        traitColors = true
        const ui = `UIColor { $0.userInterfaceStyle == .dark ? ${uiColor(dark)} : ${uiColor(v.color)} }`
        const ns = `NSColor(name: nil) { $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? ${nsColor(dark)} : ${nsColor(v.color)} }`
        add('Colors', [...head, '#if canImport(UIKit) && !os(watchOS)', `${pad}${pub}static let ${name} = Color(${ui})`, '#elseif canImport(AppKit)', `${pad}${pub}static let ${name} = Color(${ns})`, '#else', `${pad}${pub}static let ${name} = ${staticColor(v.color)}`, '#endif'])
        needs.uikitColors.push({ name, line: ui })
      }
      continue
    }
    if (v.points !== undefined) add(e.group, [...head, `${pad}${pub}static let ${name}: CGFloat = ${n(v.points)}`])
    else if (v.number !== undefined) add(e.group, [...head, `${pad}${pub}static let ${name}: Double = ${n(v.number)}`])
    else if (v.weight !== undefined) add(e.group, [...head, `${pad}${pub}static let ${name}: Font.Weight = .${weightName(v.weight)}`])
    else if (v.family) {
      if (!v.family.system) notes.push(`${e.t.name}: the family ${v.family.name} must be bundled with the app and registered (UIAppFonts) before SwiftUI can use it`)
      if (v.family.design && !SWIFT_DESIGNS.includes(v.family.design)) notes.push(`${e.t.name}: iOS has no ${v.family.design} system font, so ${v.family.design} is the system font there`)
      add(e.group, [...head, `${pad}${pub}static let ${name}: String = ${stringLiteral(SWIFT_DESIGNS.includes(v.family.design) ? v.family.design : v.family.system ? 'system' : v.family.name)}`])
    } else if (v.ms !== undefined) add(e.group, [...head, `${pad}${pub}static let ${name}: TimeInterval = ${n(v.ms / 1000)}`])
    else if (v.curve) add(e.group, [...head, `${pad}${pub}static let ${name}: (x1: Double, y1: Double, x2: Double, y2: Double) = (${v.curve.map(n).join(', ')})`])
    else if (v.text) {
      const style = textStyleOf(e.t.path, options.textStyles)
      if (style.why) {
        skipped.push({ token: e.t.name, why: style.why })
        continue
      }
      if (!style.style && !style.fixed) {
        skipped.push({ token: e.t.name, why: 'has no iOS text style to scale with, so its size would not follow Dynamic Type: map it in tokens.mobile.textStyles (or name it body, caption…), or set it to "fixed" there' })
        continue
      }
      const t = v.text
      const weight = t.weight ? weightName(t.weight) : null
      let font
      const w = weight ? `.weight(.${weight})` : ''
      if (!t.family || t.family.system) {
        const known = SWIFT_DESIGNS.includes(t.family?.design)
        if (t.family?.design && !known) notes.push(`${e.t.name}: iOS has no ${t.family.design} system font, so ${t.family.design} is the system font there`)
        const design = known ? `, design: .${t.family.design}` : ''
        const system = (s) => `Font.system(.${s}${design})${w}`
        font = style.style ? available(system(style.style), system(LATER_STYLES[style.style] ?? style.style)) : `Font.system(size: ${n(t.size)}${weight ? `, weight: .${weight}` : ''}${design})`
        if (style.style) notes.push(`${e.t.name}: the system font takes the size of the ${style.style} text style and scales with it; the token's ${n(t.size)}pt is kept in size`)
      } else {
        notes.push(`${e.t.name}: the family ${t.family.name} must be bundled with the app and registered (UIAppFonts) before SwiftUI can use it`)
        const family = stringLiteral(t.family.name)
        // Before iOS 14 a custom font has a size alone, which does not scale.
        const later = style.style ? `Font.custom(${family}, size: ${n(t.size)}, relativeTo: .${style.style})${w}` : `Font.custom(${family}, fixedSize: ${n(t.size)})${w}`
        font = available(later, `Font.custom(${family}, size: ${n(t.size)})${w}`)
      }
      needs.textStyle = true
      add(e.group, [...head, `${pad}${pub}static let ${name} = ${ns}TextStyle(font: ${font}, size: ${n(t.size)}, lineHeight: ${t.lineHeight === null ? 'nil' : n(t.lineHeight)}, tracking: ${t.tracking === null ? 'nil' : n(t.tracking)})`])
    } else if (v.shadow) {
      needs.shadow = true
      if (v.shadow.some((l) => l.spread !== 0 || l.inset)) notes.push(`${e.t.name}: a shadow's spread and inset are not carried over; SwiftUI's shadow has neither`)
      const layers = v.shadow.map((l) => `${ns}Shadow(color: ${staticColor(l.color)}, blur: ${n(l.blur)}, x: ${n(l.x)}, y: ${n(l.y)})`)
      add(e.group, [...head, `${pad}${pub}static let ${name}: [${ns}Shadow] = [${layers.join(', ')}]`])
    } else if (v.border) {
      needs.border = true
      if (!['solid', 'dashed'].includes(v.border.style)) notes.push(`${e.t.name}: the stroke style ${v.border.style} is not carried over; it is written as solid`)
      add(e.group, [...head, `${pad}${pub}static let ${name} = ${ns}Border(width: ${n(v.border.width)}, color: ${staticColor(v.border.color)}, dashed: ${v.border.style === 'dashed'})`])
    } else if (v.gradient) {
      notes.push(`${e.t.name}: a gradient's stops are carried over; its direction is set where it is drawn`)
      add(e.group, [...head, `${pad}${pub}static let ${name} = Gradient(stops: [${v.gradient.map((s) => `.init(color: ${staticColor(s.color)}, location: ${n(s.position)})`).join(', ')}])`])
    }
  }
  for (const e of entries) for (const note of e.notes) notes.push(`${e.t.name}: ${note}`)

  const out = [`// ${header}`, '// massimo mobile output, format 1', '', 'import SwiftUI']
  if (traitColors) {
    out.push('#if canImport(UIKit)', 'import UIKit', '#elseif canImport(AppKit)', 'import AppKit', '#endif')
    notes.push('on watchOS, which has no light and dark appearance, colours built from their components take their light value, as a catalog colour does there')
  }
  else if (options.uikit) out.push('#if canImport(UIKit)', 'import UIKit', '#endif')
  out.push('')
  // Outside a package, the bundle that holds this file, which is the app's or the framework's.
  if (!ctx.inPackage && catalogColors) out.push(`private final class ${ns}BundleToken {}`, `private let ${bundle} = Bundle(for: ${ns}BundleToken.self)`, '')
  out.push(`${pub}enum ${ns} {`)
  const order = [...groups.keys()].sort((a, b) => groupRank(a) - groupRank(b) || (a < b ? -1 : a > b ? 1 : 0))
  order.forEach((group, i) => {
    if (i > 0) out.push('')
    out.push(`    ${pub}enum ${group} {`, ...groups.get(group), '    }')
  })
  if (options.uikit && needs.uikitColors.length > 0) {
    // UIColor(named:in:compatibleWith:) and the dynamic provider are not on watchOS.
    out.push('', '#if canImport(UIKit) && !os(watchOS)', `    ${pub}enum UIColors {`, ...needs.uikitColors.map((c) => `${pad}${pub}static let ${c.name} = ${c.line}`), '    }', '#endif')
  }
  out.push('}')
  if (needs.textStyle) {
    out.push('', `/// A text style: the font, which scales with Dynamic Type unless it was made fixed, and the size, line height and tracking in points it was made from.`)
    out.push(`${pub}struct ${ns}TextStyle: Sendable {`, `    ${pub}let font: Font`, `    ${pub}let size: CGFloat`, `    ${pub}let lineHeight: CGFloat?`, `    ${pub}let tracking: CGFloat?`)
    out.push('', '    /// The space SwiftUI adds between lines for this line height.', `    ${pub}var lineSpacing: CGFloat { max(0, (lineHeight ?? size) - size) }`, '}')
  }
  if (needs.shadow) {
    out.push('', '/// One shadow layer. SwiftUI\'s shadow radius is about half the blur.', `${pub}struct ${ns}Shadow: Sendable {`, `    ${pub}let color: Color`, `    ${pub}let blur: CGFloat`, `    ${pub}let x: CGFloat`, `    ${pub}let y: CGFloat`, '', `    ${pub}var radius: CGFloat { blur / 2 }`, '}')
  }
  if (needs.border) {
    out.push('', `${pub}struct ${ns}Border: Sendable {`, `    ${pub}let width: CGFloat`, `    ${pub}let color: Color`, `    ${pub}let dashed: Bool`, '}')
  }
  // What the file declares, as `Group.member`, for Figma's code syntax.
  const left = new Set(skipped.map((x) => x.token))
  const names = new Map(entries.filter((e) => !left.has(e.t.name)).map((e) => [e.t.name, `${e.group}.${e.swift}`]))
  return { text: `${out.join('\n')}\n`, skipped, notes, names }
}
