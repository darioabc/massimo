// Vue components in the graph: the tokens a bound class reads, the props a
// .vue call site sets, the variants a component types through a map kept in
// its folder's index.ts, and the token edges that stay once a style file
// imports the token outputs in place of its own declarations.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { callSiteUsage, componentProps } from '../scripts/lib/props.mjs'
import { read, readJson, run } from './helpers.mjs'

// A scratch repo holding `files`, with `config` as its massimo.config.json.
function repoOf(files, config) {
  const root = mkdtempSync(join(tmpdir(), 'massimo-vue-'))
  for (const [path, text] of Object.entries({ ...files, 'massimo.config.json': JSON.stringify(config) })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return { root, project: join(root, 'ds'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// The graph of a scratch repo, and its README when `docs` is set.
function graphOf(files, config, { docs = false } = {}) {
  const t = repoOf(files, config)
  try {
    const r = run('graph', t)
    assert.equal(r.status, 0, r.stderr)
    if (docs) assert.equal(run('docs', t).status, 0)
    const json = readJson(t.project, 'graph.json')
    return { json, md: read(t.project, 'graph.md'), node: (name) => json.nodes.find((n) => n.name === name), readme: docs ? read(t.project, 'README.md') : null }
  } finally {
    t.cleanup()
  }
}

const vueConfig = (extra = {}) => ({
  version: 1,
  framework: 'vue',
  styling: ['tailwind4'],
  components: { include: ['src/components/**/*.vue'], exclude: [] },
  consumers: ['src/**/*.{vue,ts}'],
  aliases: {},
  ...extra,
  tokens: { styleFiles: ['src/styles.css'], ...extra.tokens },
})

const THEME = '@import "tailwindcss";\n\n@theme inline {\n  --color-card: var(--card);\n  --color-card-foreground: var(--card-foreground);\n  --color-primary: var(--primary);\n}\n'

test('a .vue bound class reads its theme tokens as a static class does, in cn(), an object and v-bind:class', () => {
  const g = graphOf(
    {
      'src/styles.css': THEME,
      'src/components/Panel.vue': `<script setup lang="ts">
import { cn } from '../cn'
const props = defineProps<{ class?: string; active?: boolean }>()
</script>

<template>
  <div
    :class="
      cn(
        'bg-card text-card-foreground flex flex-col gap-6',
        props.class,
      )
    "
  >
    <span v-bind:class="{ 'text-primary': active, 'opacity-50': !active }" :title="label('Save, then close.')"><slot /></span>
  </div>
</template>
`,
      'src/cn.ts': 'export const cn = (...a: unknown[]) => a.join(" ")\n',
    },
    vueConfig(),
  )
  assert.deepEqual(g.node('Panel').style.tokens, ['card', 'card-foreground', 'primary'])
})

test('a word in a .vue bound class is a class-library root, as in a static class; a bound value that is no class list adds none', () => {
  const g = graphOf(
    {
      'src/styles.css': '@import "tailwindcss";\n',
      'src/components/Tile.vue': `<template>\n  <div :class="cn('card', props.class)" :aria-label="t('menu, open')" :title="t('modal', count)"><slot /></div>\n</template>\n`,
    },
    vueConfig({ styling: ['tailwind4', 'daisyui'] }),
  )
  assert.deepEqual(g.node('Tile').style.classes, { daisyui: ['card'] })
})

test('an operand of a comparison in a .vue bound class is a value, not a class', () => {
  const g = graphOf(
    {
      'src/styles.css': '@import "tailwindcss";\n',
      'src/components/Anchor.vue': `<template>\n  <a :class="variant === 'link' ? 'card' : 'no-underline'"><slot /></a>\n  <b :class="'menu' !== tone ? 'badge' : 'x-y'" />\n</template>\n`,
    },
    vueConfig({ styling: ['tailwind4', 'daisyui'] }),
  )
  assert.deepEqual(g.node('Anchor').style.classes, { daisyui: ['badge', 'card'] })
})

test('a component keeps its token edges once its style file imports the css and tailwind4 outputs in place of its own declarations', () => {
  const component = `<template>\n  <div class="bg-card text-card-foreground"><span class="text-primary bg-ink" /></div>\n</template>\n`
  const before = graphOf({ 'src/styles.css': THEME, 'src/components/Panel.vue': component }, vueConfig())
  const after = graphOf(
    {
      'src/styles.css': '@import "tailwindcss";\n@import "./tokens.css";\n@import "./tokens.theme.css";\n',
      'src/tokens.css': ':root {\n  --card: #fff;\n  --card-foreground: #111;\n  --primary: #00f;\n  --color-ink: #222;\n}\n',
      'src/tokens.theme.css': THEME.replace('@import "tailwindcss";\n\n', ''),
      'src/components/Panel.vue': component,
    },
    vueConfig({
      tokens: {
        outputs: [
          { format: 'css', path: 'src/tokens.css' },
          { format: 'tailwind4', path: 'src/tokens.theme.css' },
          { format: 'scss', path: 'src/_tokens.scss' },
          { format: 'json', path: 'src/not-built.json' },
        ],
      },
    }),
  )
  assert.deepEqual(before.node('Panel').style.tokens, ['card', 'card-foreground', 'primary'])
  assert.deepEqual(after.node('Panel').style.tokens, ['card', 'card-foreground', 'ink', 'primary'])
  // The style files' own token list is what it was: the outputs only name colours.
  assert.deepEqual(after.json.tokens.styleFiles, ['src/styles.css'])
  assert.equal(after.json.tokens.total, 0)
  // graph.md names the outputs the style file imports; the scss output and the unbuilt one are not css it reads.
  assert.match(after.md, /Colour tokens also come from the built token outputs these files import: `src\/tokens\.css`, `src\/tokens\.theme\.css`\./)
  assert.doesNotMatch(before.md, /built token outputs/)
})

test('a .vue call site: directives, slots, events, key and ref set no prop; a bound prop drops its colon; kebab names are the camelCase prop', () => {
  const page = `<template>
  <Badge v-if="summary" :variant="entry.role === 'ADMIN' ? 'default' : 'secondary'" :key="entry.id" ref="badge" />
  <Badge v-else variant="secondary" v-bind:size="'sm'" :pill="true" #default="{ item }" @click="go" v-on:focus="f" />
  <Badge v-for="x in xs" v-model="value" v-show="open" v-bind="$attrs" :action-label="\`Open \${x}\`" action-label="Plain" aria-label="Badge" :data-state="state" />
  <Badge v-slot:icon="{ c }" :class="c" class="x" :style="s" v-model:open="o" :on-close="close" :count="3" />
</template>
`
  assert.deepEqual(callSiteUsage('Badge', [{ file: 'src/pages/index.vue', text: page }]), {
    variant: { '{…}': 1, secondary: 1 },
    size: { sm: 1 },
    pill: { true: 1 },
    actionLabel: { '{…}': 1, Plain: 1 },
    'aria-label': { Badge: 1 },
    'data-state': { '{…}': 1 },
    count: { '{…}': 1 },
  })
  // A dynamic argument names no prop that is known.
  assert.deepEqual(callSiteUsage('Badge', [{ file: 'src/pages/index.vue', text: '<Badge :[attr]="x" v-bind:[name]="y" @[event].prevent="z" #[slot]="s" tone="info" />' }]), { tone: { info: 1 } })
  // The same text outside a .vue file reads as it always has.
  assert.deepEqual(Object.keys(callSiteUsage('Badge', [{ file: 'src/page.tsx', text: '<Badge v-if="a" :variant="b" />' }])).sort(), [':variant', 'v-if'])
})

test('the graph merges a .vue call site\'s kebab-case and bound props with the props the component declares', () => {
  const g = graphOf(
    {
      'src/styles.css': '@import "tailwindcss";\n',
      'src/components/ActionsMenu.vue': `<script setup lang="ts">\ndefineProps<{ actionLabel: string; commentId: string }>()\n</script>\n<template><button :aria-label="actionLabel" /></template>\n`,
      'src/components/Comment.vue': `<script setup lang="ts">\nimport ActionsMenu from './ActionsMenu.vue'\n</script>\n<template>\n  <ActionsMenu v-if="canEdit" :action-label="label" :comment-id="comment.id" :key="comment.id" />\n</template>\n`,
    },
    vueConfig(),
  )
  assert.deepEqual(g.node('ActionsMenu').props, [
    { name: 'actionLabel', from: 'type', usage: { '{…}': 1 } },
    { name: 'commentId', from: 'type', usage: { '{…}': 1 } },
  ])
})

const BUTTON_INDEX = `import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

export { default as Button } from "./Button.vue";

export const buttonVariants = cva(
  "inline-flex items-center",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        outline: "border bg-background",
      },
      size: {
        "default": "h-9 px-4",
        "sm": "h-8 px-3",
        "icon": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
export type ButtonVariants = VariantProps<typeof buttonVariants>;
`

const BUTTON = `<!-- ds:group Primitives / Actions -->
<!-- ds:use-when any action a person triggers -->
<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import type { ButtonVariants } from ".";
import { Primitive } from "reka-ui";
import { buttonVariants } from ".";

interface Props extends PrimitiveProps {
  variant?: ButtonVariants["variant"];
  size?: ButtonVariants["size"];
  class?: HTMLAttributes["class"];
}

const props = withDefaults(defineProps<Props>(), {
  as: "button",
});
</script>

<template>
  <Primitive :class="buttonVariants({ variant, size })"><slot /></Primitive>
</template>
`

const BADGE_INDEX = `import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

export const badgeVariants = cva("inline-flex", {
  variants: { variant: { default: "bg-primary", secondary: "bg-secondary" } },
  defaultVariants: { variant: "default" },
});
export type BadgeVariants = VariantProps<typeof badgeVariants>;
`

const BADGE = `<!-- ds:group Primitives / Status -->
<!-- ds:use-when a short label -->
<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui";
import type { BadgeVariants } from ".";
import { badgeVariants } from ".";

const props = defineProps<PrimitiveProps & {
  variant?: BadgeVariants["variant"];
  class?: string;
}>();
</script>

<template>
  <span :class="badgeVariants({ variant })"><slot /></span>
</template>
`

const PAGE_ITEM = `<script setup lang="ts">
import type { ButtonVariants } from "@/components/ui/button";

const props = withDefaults(defineProps<{
  size?: ButtonVariants["size"];
  isActive?: boolean;
}>(), {
  size: "icon",
});
</script>

<template><button /></template>
`

test('a component typed through the variant map in its folder\'s index.ts takes its values and defaults, and the README lists them', () => {
  const g = graphOf(
    {
      'src/styles.css': '@import "tailwindcss";\n',
      'src/components/ui/button/index.ts': BUTTON_INDEX,
      'src/components/ui/button/Button.vue': BUTTON,
      'src/components/ui/badge/index.ts': BADGE_INDEX,
      'src/components/ui/badge/Badge.vue': BADGE,
      'src/components/ui/pagination/PaginationItem.vue': PAGE_ITEM,
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    },
    vueConfig(),
    { docs: true },
  )
  assert.deepEqual(g.node('Button').props, [
    { name: 'class', optional: true, from: 'type' },
    { name: 'size', values: ['default', 'sm', 'icon'], default: 'default', optional: true, from: 'type' },
    { name: 'variant', values: ['default', 'outline'], default: 'default', optional: true, from: 'type' },
  ])
  assert.deepEqual(g.node('Badge').props, [
    { name: 'class', optional: true, from: 'type' },
    { name: 'variant', values: ['default', 'secondary'], default: 'default', optional: true, from: 'type' },
  ])
  // The component's own withDefaults() comes before the map's defaultVariants.
  assert.deepEqual(g.node('PaginationItem').props.find((p) => p.name === 'size'), { name: 'size', values: ['default', 'sm', 'icon'], default: 'icon', optional: true, from: 'type' })
  assert.match(g.readme, /\| Badge \| a short label \| variant: default, secondary \|/)
  assert.match(g.readme, /\| Button \| any action a person triggers \| size: default, sm, icon; variant: default, outline \|/)
})

test('props typed through a variant map read the map only when the module that holds it is given', () => {
  const sourceOf = (name) => (['ButtonVariants', 'buttonVariants'].includes(name) ? BUTTON_INDEX : null)
  const withMap = Object.fromEntries(componentProps(BUTTON, 'Button.vue', 'Button', sourceOf).map((p) => [p.name, p]))
  assert.deepEqual(withMap.variant, { name: 'variant', values: ['default', 'outline'], default: 'default', optional: true, from: 'type' })
  const alone = Object.fromEntries(componentProps(BUTTON, 'Button.vue', 'Button').map((p) => [p.name, p]))
  assert.deepEqual(alone.variant, { name: 'variant', optional: true, from: 'type' })
  // The object literal a generic argument holds is not the props' own.
  const generic = `<script setup lang="ts">\nconst props = defineProps<Omit<{ hidden: string }, 'hidden'> & { variant?: string }>()\n</script>\n`
  assert.deepEqual(componentProps(generic, 'Tag.vue', 'Tag').map((p) => p.name), ['variant'])
  // An indexed type whose module holds no variant map adds nothing.
  const other = Object.fromEntries(componentProps(BUTTON, 'Button.vue', 'Button', () => 'export type ButtonVariants = { variant: string }').map((p) => [p.name, p]))
  assert.deepEqual(other.variant, { name: 'variant', optional: true, from: 'type' })
})

const ACTION_INDEX = `import { cva } from "class-variance-authority";

export const actionVariants = cva("inline-flex ring-ring", {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground",
      outline: ["border bg-background", "shadow-[0_0_0_1px_var(--edge)]"],
    },
    size: { sm: "h-8", lg: "h-10" },
  },
  compoundVariants: [{ variant: "outline", size: "sm", class: "text-muted" }],
  defaultVariants: { variant: "default" },
});
export const notAMap = (...a: string[]) => "bg-card " + a.join(" ");
`

// A component in the action folder whose template calls `call`.
const actionCaller = (call, imports = 'actionVariants') => `<script setup lang="ts">
import { ${imports} } from "@/components/ui/action";
import { cn } from "@/lib/cn";
const props = defineProps<{ variant?: string; size?: string; class?: string }>();
</script>

<template>
  <button :class="cn(${call}, props.class)"><slot /></button>
</template>
`

test('a component reads the classes of the cva map it imports and calls: the option a literal picks, the default it leaves out, every option an expression may pick', () => {
  const theme = '@import "tailwindcss";\n\n@theme inline {\n' + ['background', 'card', 'muted', 'primary', 'primary-foreground', 'ring'].map((c) => `  --color-${c}: var(--${c});\n`).join('') + '}\n'
  const g = graphOf(
    {
      'src/styles.css': theme,
      'src/lib/cn.ts': 'export const cn = (...a: unknown[]) => a.join(" ")\n',
      'src/components/ui/action/index.ts': ACTION_INDEX,
      'src/components/ui/action/Action.vue': actionCaller('actionVariants({ variant, size })'),
      'src/components/ui/action/ActionOutline.vue': actionCaller("actionVariants({ variant: 'outline' })"),
      'src/components/ui/action/ActionPlain.vue': actionCaller('actionVariants()'),
      'src/components/ui/action/ActionTyped.vue': actionCaller('props.class', 'type actionVariants'),
      'src/components/ui/action/ActionOther.vue': actionCaller('notAMap("x")', 'notAMap'),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    },
    vueConfig(),
  )
  const style = (name) => ({ tokens: g.node(name).style.tokens, cssVars: g.node(name).style.cssVars })
  assert.deepEqual(style('Action'), { tokens: ['background', 'muted', 'primary', 'primary-foreground', 'ring'], cssVars: ['--edge'] })
  assert.deepEqual(style('ActionOutline'), { tokens: ['background', 'muted', 'ring'], cssVars: ['--edge'] })
  assert.deepEqual(style('ActionPlain'), { tokens: ['muted', 'primary', 'primary-foreground', 'ring'], cssVars: [] })
  // Importing the map without calling it, or calling a function that is no map, reads nothing from it.
  assert.deepEqual(style('ActionTyped'), { tokens: [], cssVars: [] })
  assert.deepEqual(style('ActionOther'), { tokens: [], cssVars: [] })
})

const PLAIN_BUTTON = `<script setup lang="ts">
import type { CornerStyle } from './types'

const props = withDefaults(
  defineProps<{
    type?: string;
    cornerStyle?: CornerStyle;
    size?: string;
    label?: string;
    disabled?: boolean;
  }>(),
  {
    type: 'primary',
    cornerStyle: 'rounded',
    disabled: false,
    label: undefined,
  },
)
</script>

<template><span :class="props.type"><slot /></span></template>
`

test('withDefaults() gives ordinary typed props their defaults', () => {
  const props = Object.fromEntries(componentProps(PLAIN_BUTTON, 'button.vue', 'button').map((p) => [p.name, p]))
  assert.deepEqual(props.type, { name: 'type', default: 'primary', optional: true, from: 'type' })
  assert.deepEqual(props.cornerStyle, { name: 'cornerStyle', default: 'rounded', optional: true, from: 'type' })
  assert.deepEqual(props.disabled, { name: 'disabled', values: ['true', 'false'], default: 'false', optional: true, from: 'type' })
  // A default that is no literal names none.
  assert.deepEqual(props.label, { name: 'label', optional: true, from: 'type' })
})

test('a .vue call site is read from the tag its import binds, never from a native element named like the file', () => {
  const g = graphOf(
    {
      'src/styles.css': '@import "tailwindcss";\n',
      'src/components/ui/button/button.vue': PLAIN_BUTTON,
      'src/components/ui/button/types.ts': "export type CornerStyle = 'rounded' | 'pill'\n",
      'src/components/tab-bar.vue': `<script setup lang="ts">
import UiButton from './ui/button/button.vue'
</script>

<template>
  <button v-for="tab in tabs" :key="tab" type="button">{{ tab }}</button>
  <ui-button type="transparent" corner-style="pill" />
  <UiButton type="tertiary" :disabled="true" />
  <ui-button-group size="small" />
</template>
`,
    },
    vueConfig(),
  )
  assert.deepEqual(g.node('button').props, [
    { name: 'cornerStyle', default: 'rounded', optional: true, from: 'type', usage: { pill: 1 } },
    { name: 'disabled', values: ['true', 'false'], default: 'false', optional: true, from: 'type', usage: { true: 1 } },
    { name: 'label', optional: true, from: 'type' },
    { name: 'size', optional: true, from: 'type' },
    { name: 'type', default: 'primary', optional: true, from: 'type', usage: { transparent: 1, tertiary: 1 } },
  ])
})

test('in a Nuxt app, a call site is read from the name Nuxt registers, in PascalCase or kebab case', () => {
  const g = graphOf(
    {
      'nuxt.config.ts': 'export default defineNuxtConfig({})\n',
      'app/components/base/Card.vue': '<script setup lang="ts">\ndefineProps<{ title: string }>()\n</script>\n<template><section><slot /></section></template>\n',
      'app/pages/index.vue': '<template>\n  <base-card title="Hello" />\n  <BaseCard title="Again" />\n  <card title="Native" />\n</template>\n',
      'app/pages/about.vue': '<script setup lang="ts">\nimport { BaseCard } from "#components"\n</script>\n<template>\n  <BaseCard title="Imported" />\n</template>\n',
    },
    { ...vueConfig(), framework: 'nuxt', components: { include: ['app/components/**/*.vue'], exclude: [] }, consumers: ['app/**/*.vue'] },
  )
  assert.equal(g.node('Card').usage, 2)
  assert.deepEqual(g.node('Card').props, [{ name: 'title', from: 'type', usage: { Hello: 1, Again: 1, Imported: 1 } }])
})
