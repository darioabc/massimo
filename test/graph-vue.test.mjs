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
    return { json, node: (name) => json.nodes.find((n) => n.name === name), readme: docs ? read(t.project, 'README.md') : null }
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
  // An indexed type whose module holds no variant map adds nothing.
  const other = Object.fromEntries(componentProps(BUTTON, 'Button.vue', 'Button', () => 'export type ButtonVariants = { variant: string }').map((p) => [p.name, p]))
  assert.deepEqual(other.variant, { name: 'variant', optional: true, from: 'type' })
})
