// Component props, variants, states and call-site usage, read from source.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { callSiteUsage, componentProps, componentStates } from '../scripts/lib/props.mjs'
import { readJson, run, scratch } from './helpers.mjs'

const byName = (list) => Object.fromEntries(list.map((p) => [p.name, p]))

test('TypeScript props: unions as values, booleans, handlers and slots, defaults from parameters', () => {
  const src = `
    export interface ButtonProps {
      /** the look */
      variant?: 'primary' | 'secondary' | "ghost"
      size?: 'sm' | 'md'
      disabled?: boolean
      onClick?: (event: MouseEvent) => void
      children: React.ReactNode
      label: string
    }
    export function Button({ variant = 'primary', size = 'md', disabled = false, ...rest }: ButtonProps) {}`
  const p = byName(componentProps(src, 'Button.tsx', 'Button'))
  assert.deepEqual(p.variant, { name: 'variant', values: ['primary', 'secondary', 'ghost'], default: 'primary', optional: true, from: 'type' })
  assert.deepEqual(p.disabled.values, ['true', 'false'])
  assert.equal(p.disabled.default, 'false')
  assert.equal(p.onClick.kind, 'handler')
  assert.equal(p.children.kind, 'slot')
  assert.deepEqual(p.label, { name: 'label', from: 'type' })
})

test('cva and tv variant maps, Vue, Svelte 4 and 5', () => {
  const cva = `const button = cva('inline-flex', { variants: { tone: { neutral: 'a', danger: 'b' }, size: { sm: 'c', lg: 'd' } }, defaultVariants: { tone: 'neutral' } })`
  assert.deepEqual(byName(componentProps(cva, 'B.tsx', 'B')).tone, { name: 'tone', values: ['neutral', 'danger'], default: 'neutral', from: 'variants' })
  const tv = `export const card = tv({ base: 'x', variants: { elevated: { true: 'shadow' } } })`
  assert.deepEqual(byName(componentProps(tv, 'C.tsx', 'C')).elevated.values, ['true'])
  const vue = `<script setup lang="ts">\nconst props = defineProps<{ tone?: 'info' | 'warn'; count: number }>()\n</script>`
  assert.deepEqual(byName(componentProps(vue, 'Badge.vue', 'Badge')).tone.values, ['info', 'warn'])
  const vueObj = `defineProps({ size: { type: String, default: 'md' }, label: String })`
  assert.deepEqual(componentProps(vueObj, 'X.vue', 'X').map((p) => [p.name, p.default]), [['size', 'md'], ['label', undefined]])
  const svelte4 = `<script>\n export let label = 'Save'\n export let kind: 'a' | 'b' = 'a'\n</script>`
  assert.deepEqual(byName(componentProps(svelte4, 'S.svelte', 'S')).kind, { name: 'kind', values: ['a', 'b'], default: 'a', from: 'type' })
  const svelte5 = `<script>\n let { tone = 'info', open, ...rest } = $props()\n</script>`
  assert.deepEqual(componentProps(svelte5, 'T.svelte', 'T').map((p) => [p.name, p.default]), [['tone', 'info'], ['open', undefined]])
})

test('Astro props: defaults from the frontmatter destructuring of Astro.props, ahead of a helper in the frontmatter', () => {
  const src = `---
interface Props {
  title?: string
  variant?: 'solid' | 'outline'
  wide?: boolean
  label?: string
}
const {
  title,
  variant = 'solid',
  wide = false,
  label = strings.send,
  ...rest
} = Astro.props;
const tags = list.map(({ variant = 'plain' }) => variant)
---
<a class:list={[variant, { wide }]}>{label}{title}</a>`
  const p = byName(componentProps(src, 'Action.astro', 'Action'))
  assert.equal(p.variant.default, 'solid')
  assert.equal(p.wide.default, 'false')
  assert.equal(p.label.default, undefined) // an expression is no default to show
  assert.equal(p.title.default, undefined)
})

test('states: Tailwind variants, CSS pseudo-classes, ARIA, data attributes and state props', () => {
  const src = `<button className="hover:bg-x focus-visible:ring disabled:opacity-50 aria-expanded:rotate-180 data-[state=open]:block group-hover:underline" />
    .x:hover { } .x:focus-visible { } [aria-invalid="true"] { }`
  assert.deepEqual(componentStates(src, [{ name: 'loading' }, { name: 'tone' }]), [
    'aria-expanded', 'aria-invalid=true', 'data-[state=open]', 'disabled', 'focus-visible', 'hover', 'loading',
  ])
})

test('call sites: values counted per prop; bare attributes are true, expressions {…}', () => {
  const files = [
    { text: `<Button variant="primary" size='sm'>Go</Button><Button variant={'ghost'} disabled /><ButtonGroup variant="x" />` },
    { text: `<Button variant="primary" onClick={() => go()} className="x" count={n} />` },
  ]
  assert.deepEqual(callSiteUsage('Button', files), {
    variant: { primary: 2, ghost: 1 },
    size: { sm: 1 },
    disabled: { true: 1 },
    count: { '{…}': 1 },
  })
})

test('the graph carries each component\'s props, usage and states', () => {
  const t = scratch()
  try {
    mkdirSync(join(t.root, 'src', 'components'), { recursive: true })
    writeFileSync(join(t.root, 'src', 'components', 'Pill.tsx'), `
      export interface PillProps { tone?: 'neutral' | 'danger'; selected?: boolean }
      export function Pill({ tone = 'neutral', selected }: PillProps) {
        return <span className="hover:underline aria-selected:font-bold">{tone}</span>
      }`)
    writeFileSync(join(t.root, 'src', 'routes', 'pills.tsx'), `import { Pill } from '@/components/Pill'\nexport default () => <div><Pill tone="danger" selected /><Pill /></div>\n`)
    assert.equal(run('graph', t).status, 0)
    const pill = readJson(t.project, 'graph.json').nodes.find((n) => n.name === 'Pill')
    assert.deepEqual(pill.props, [
      { name: 'selected', values: ['true', 'false'], optional: true, from: 'type', usage: { true: 1 } },
      { name: 'tone', values: ['neutral', 'danger'], default: 'neutral', optional: true, from: 'type', usage: { danger: 1 } },
    ])
    assert.deepEqual(pill.states, ['aria-selected', 'hover', 'selected'])
  } finally {
    t.cleanup()
  }
})
