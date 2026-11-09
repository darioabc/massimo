# Recipe: Vite, csf lane (an adopted Ladle repo)

For a repo whose stories are CSF files in Ladle's form (a default export with the title, one named export per state) and that has opted in with `adopt.mjs config --write --lane csf`. The story files stay where they are and are never copied. massimo's Vite plugin reads them at dev and build time, works out the registry (every state's id, route and merged meta), and serves the lane from it, so no route table is checked in and the app's CSS is imported, never copied. A lane for any other repo, Storybook's included, follows `vite.md`.

The lane runs beside the old tool until every printed edit is made: its own port, its own config, its own output folder. Ladle's links keep working on it, since `/?story=<id>` renders in place.

## How it works

| URL | What renders |
|---|---|
| `/`, `/stories` | the shell, with `stories.home` selected |
| `/stories?s=<id>` | the shell, with that state selected |
| `/stories/<slug>` | the shell; the states side by side when the file is in `stories.sideBySide` |
| `/stories/<slug>/<state>` | the canvas: that state alone in its own document |
| `/?story=<id>` | Ladle's link: the shell, in place, with that state selected |
| `/?story=<id>&mode=preview` | Ladle's preview link: the canvas, in place |
| `/meta.json` | every state in the shape of Ladle's own `meta.json` |

Any URL may carry `mode=preview` (no banner, no switchers), a switch as `<name>=<value>`, and Ladle's args as `arg-<name>=<value>`. A legacy URL is never redirected: specs that act straight after loading one see the state at once.

**The shell** shows one state at a time in an iframe of a fixed size from `stories.viewports` (a width of 0 fills the pane), with every other state one click away in the sidebar. States that shared a document or an origin's storage could disturb each other: harnesses that patch globals, seed a session or write storage are written for one state at a time. So each state renders alone in its own canvas document, and only a file listed in `stories.sideBySide` gets a link that shows its states together. The shell holds the switchers and the banner, loads its iframe with `mode=preview` and the switch values, and never calls `history`: every choice is a link. An iframe is never sized to its content, since a `min-h-screen` story would then grow without end.

**The canvas** renders one state per document. It reads its query once, sets each switch's attribute on `<html>` before the story paints (a switch whose `default` is null asks the frame's `switchDefaults`), renders the state inside the project's frame, and sets `<html data-story-ready>` once the state and its effects have run; a state that throws sets `data-story-error` instead. With `mode=preview` it shows no banner and no switchers, which is how the shell, sweeps and screenshots load it. Outside preview it applies `meta.width` to the story's container, as Ladle does: a number of px, or a width name that a viewport's label, or else one of Ladle's default names (`xsmall` 414, `small` 640, `medium` 768, `large` 1024), maps to px. It never reads `parameters.width`, which Ladle does not honour either. A story's `args` and `argTypes`, the default export's under the story's, become its props at run time, with `arg-<name>` from the URL read by control type as Ladle reads them. On `pagehide` it unmounts, so a harness's cleanup runs before the next state loads. It refuses a registry in a format newer than its own with "update the lane scaffold".

**The plugin** (`<project>/scripts/lib/vite-stories.mjs`, vendored by init) is a plain Vite plugin object, so massimo stays free of dependencies and the project's own Vite runs it. It adds to the lane's config: aliases from the tsconfig `paths` the repo declares; React pinned to the install root, the first folder up that holds `node_modules/react` (a worktree borrows its parent's install), with `resolve.dedupe`; `server.fs.allow` for the install root and the repo; `optimizeDeps.entries` set to `stories.include` and `stories.html`, since the dependency scan cannot follow the lane's loaders; `cacheDir` at `node_modules/.vite-stories`; `stories.port` with `strictPort`; and the build's input and `stories.outDir` (`dist-stories` when unset). A value the lane's config sets itself wins. A watcher rebuilds the registry when a story file is added, removed or changed, and the frame's exports are read again when it changes; a changed `massimo.config.json` restarts the server. The build writes the entry as `index.html`, writes `meta.json`, writes a `_redirects` holding only `/stories/* /index.html 200` when `stories.hostFiles` lists it (a host such as Cloudflare Pages rewrites even when an asset matches, so a catch-all would serve the chunks as HTML), and leaves out an app `_redirects` or `_headers` copied from `public/`, with a warning. `vite preview` answers the lane's routes the same way.

`virtual:massimo-stories` is the only module the scaffold imports from massimo. It holds the registry and its `format`, the settings (`viewports`, the width names in `widths`, `switchers`, `banners`, the `sideBySide` files, `home`), one loader per story file, the frame, the route helpers of `lane-route.mjs` (`parseLaneUrl`, `stateUrl`, `shellUrl`), and the view helpers (`laneBanner`, `laneSwitches`, `laneWidth`, `laneAttributes`, `laneProps`). `src/stories/massimo.d.ts` declares it, so the scaffold never imports a `.mjs` file from TypeScript.

## Files

```text
stories.html                   the lane's HTML entry, at the repo root beside index.html
vite.stories.config.ts         the lane's own Vite config, with massimo's plugin
src/stories/main.tsx           reads the URL once: the shell, a canvas or a message
src/stories/Shell.tsx          one state at a time in a fixed-size iframe
src/stories/Canvas.tsx         one state per document
src/stories/story.ts           the types story files import
src/stories/massimo.d.ts       declares virtual:massimo-stories; its first line names the format
src/stories/frame.tsx          project-owned: what wraps every state
src/stories/stories.css        the app's base CSS and the lane's @source lines
src/stories/stories.extra.css  rules the lane needs and the app must never ship
```

The scaffold is the project's from then on: restyle the shell, extend the frame. Keep the shell on the canvas's URLs, and keep `Shell.tsx` and `Canvas.tsx` importing only React and `virtual:massimo-stories`.

## Config

The opt-in proposes most of this from the old tool's config; check it before scaffolding. A config that sets any of these keys needs `"minScripts": "0.4.0"`, and the vendored scripts must be 0.4.0 (`init.mjs --update-scripts`).

```json
"stories": {
  "lane": "csf",
  "ids": "ladle",
  "include": ["src/**/*.stories.{tsx,ts}"],
  "order": ["foundations--*", "primitives--*", "*"],
  "home": "foundations--welcome--start-here",
  "viewports": [
    { "label": "Mobile", "width": 375, "height": 812 },
    { "label": "Desktop", "width": 1280, "height": 800 },
    { "label": "Full", "width": 0, "height": 0 }
  ],
  "sideBySide": [],
  "switchers": [
    { "name": "scheme", "label": "Mode", "attribute": "data-theme", "values": ["auto", "light", "dark"], "unset": "auto", "default": "auto" }
  ],
  "banners": {
    "exploration": { "tone": "warning", "lead": "Exploration. Not what the app shows." }
  },
  "frame": "src/stories/frame.tsx",
  "storyOnly": [],
  "appCss": { "base": "src/index.css", "entry": null },
  "outDir": "dist-stories",
  "hostFiles": ["_redirects"],
  "port": 4650,
  "devCommand": "npm run ds:stories",
  "url": "http://localhost:4650/stories",
  "storyUrl": "http://localhost:4650/stories/{slug}/{state}"
}
```

- `ids: "ladle"` keeps Ladle's ids, so old links, specs and the redirect map stay exact.
- `order` and `home` come from Ladle's `storyOrder` and `defaultStory`; `viewports` from its width options, with a height each. Label each viewport with its option's name when stories set `meta.width` to a name, since the canvas maps a name through the labels.
- A switch names the `<html>` attribute it sets; its `unset` value removes the attribute; a `default` of null asks the frame. Use a query name the app does not read itself.
- `banners` maps a meta key to the banner a state shows when its merged meta sets that key to a non-empty string.
- Pick a port the old tool does not hold while both run.

## stories.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Stories</title>
  </head>
  <body data-massimo-stories>
    <div id="root"></div>
    <script type="module" src="/src/stories/main.tsx"></script>
  </body>
</html>
```

Copy what the app's `index.html` puts in `<head>` that affects rendering, such as font links and icons. Leave out a script that sets the theme attribute before paint: the canvas sets the switch attributes itself.

## vite.stories.config.ts

```ts
// The story lane (massimo csf lane): its own Vite config, never a merge of
// the app's, so the app's dev-only plugins, proxies and env checks stay out.
// massimo's plugin reads massimo.config.json and adds the lane's routes, the
// aliases from tsconfig paths, React pinned to the install root, the
// dependency scan's entries, its cache folder, port and build output.
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { massimoStories } from './<project>/scripts/lib/vite-stories.mjs'

export default defineConfig({
  plugins: [react(), tailwindcss(), massimoStories()],
})
```

Replace `<project>` with the project folder (`projectDir`). Add the Vite plugins the stories need to render, the ones the old tool's Vite config had (React, Tailwind, SVG imports), and the extras it carried that are not about the tool itself: dependencies it pre-bundled (`optimizeDeps: { include: [...] }`) and a cleanup call it made at load, such as removing a stray `node_modules` link. Leave out its aliases and React pinning, which the plugin adds, and any workaround for the tool's own generated code. Vite loads this file itself; it needs no tsconfig.

## src/stories/main.tsx

```tsx
// The story lane's entry (massimo csf lane). It reads the URL once and
// renders the shell, one state's canvas, or a message. Ladle's own links,
// `/?story=<id>` and `/?story=<id>&mode=preview`, render in place.
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { format, type LaneUrl, parseLaneUrl, registry } from 'virtual:massimo-stories'
import Canvas from './Canvas'
import Shell from './Shell'
import './stories.css'

// The newest registry format this scaffold reads.
const SCAFFOLD_FORMAT = 1

function Message({ children }: { children: ReactNode }) {
  return (
    <main data-lane-message style={{ font: '14px/1.5 system-ui, sans-serif', padding: 24 }}>
      {children}
      <p>
        <a href="/stories">All stories</a>
      </p>
    </main>
  )
}

function stateOf(url: LaneUrl) {
  if (url.kind === 'legacy-preview') return url.oldId ? registry.stories[url.oldId] : undefined
  const ids = url.slug ? (registry.slugs[url.slug]?.ids ?? []) : []
  return ids.map((id) => registry.stories[id]).find((story) => story?.state === url.state)
}

function page() {
  if (format > SCAFFOLD_FORMAT) {
    return (
      <Message>
        The lane's registry is format {format}, and this scaffold reads up to {SCAFFOLD_FORMAT}:
        update the lane scaffold.
      </Message>
    )
  }
  const url = parseLaneUrl(location.pathname, location.search)
  if (url.kind === 'state' || url.kind === 'legacy-preview') {
    const story = stateOf(url)
    if (story) return <Canvas story={story} url={url} />
    const asked = url.kind === 'state' ? `${url.slug}/${url.state}` : url.oldId
    return <Message>No story has the state {asked}.</Message>
  }
  if (url.kind === 'missing')
    return <Message>The story lane has no page at {location.pathname}.</Message>
  return <Shell url={url} />
}

const root = createRoot(document.getElementById('root') as HTMLElement)
root.render(page())

// One state per document: unmount on the way out, so a story's cleanups run
// before the next document loads, as on a story switch.
addEventListener('pagehide', () => root.unmount())
// A page the browser kept in its back-forward cache was unmounted: load it again.
addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload()
})
```

## src/stories/Shell.tsx

```tsx
// The lane's shell (massimo csf lane). It shows one state at a time in an
// iframe of a fixed size, with every other state one click away. States that
// shared a document or an origin's storage could disturb each other, so each
// renders alone in its own canvas document; a file listed in
// `stories.sideBySide` may show its states together. The shell never calls
// `history`: every choice is a link, and Ladle's `/?story=<id>` renders here
// in place.
import { useEffect, useMemo, useState } from 'react'
import {
  type LaneStory,
  type LaneUrl,
  type Viewport,
  lane,
  laneBanner,
  laneSwitches,
  laneWidth,
  registry,
  shellUrl,
  stateUrl,
  switchDefaults,
} from 'virtual:massimo-stories'

// The shell's own query key beside the lane's `s`: the viewport a viewer picked.
const VIEWPORT = 'viewport'
const FULL: Viewport = { label: 'Full', width: 0, height: 0 }
const sideBySide = new Set(lane.sideBySide)
const ui = { font: '13px/1.4 system-ui, sans-serif', color: '#1f2937' }

type Choices = { viewport: string | null; switches: Record<string, string> }

// The viewport a state opens at: the viewer's pick, else the one whose width
// is the state's `meta.width`, else the one that fills the pane, else the first.
function viewportFor(story: LaneStory | undefined, picked: string | null): Viewport {
  const all = lane.viewports
  const width = laneWidth(story?.meta, lane.widths)
  return (
    all.find((v) => v.label === picked) ??
    all.find((v) => width !== null && v.width === width) ??
    all.find((v) => v.width === 0) ??
    all[0] ??
    FULL
  )
}

function query(choices: Choices) {
  const params = new URLSearchParams()
  if (choices.viewport) params.set(VIEWPORT, choices.viewport)
  for (const [name, value] of Object.entries(choices.switches)) params.set(name, value)
  return params.toString()
}
const oneHref = (id: string, choices: Choices) => {
  const rest = query(choices)
  return rest ? `${shellUrl(id)}&${rest}` : shellUrl(id)
}
const togetherHref = (slug: string, choices: Choices) => {
  const rest = query(choices)
  return `/stories/${encodeURIComponent(slug)}${rest ? `?${rest}` : ''}`
}

// What the URL asks the shell to show: one state, or a slug's side-by-side
// files. `missing` is a slug the registry does not hold.
function selection(url: LaneUrl): { id: string | null; together: string[]; missing: string | null } {
  if (url.kind === 'legacy') return { id: url.oldId, together: [], missing: null }
  if (url.kind === 'slug' && url.slug) {
    const group = registry.slugs[url.slug]
    if (!group) return { id: null, together: [], missing: url.slug }
    const together = group.files.filter((f) => sideBySide.has(f))
    return { id: group.ids[0] ?? null, together, missing: null }
  }
  return { id: url.selected ?? lane.home ?? registry.order[0] ?? null, together: [], missing: null }
}

// What the shell says when it has no state to show.
function nothing(id: string | null, missing: string | null) {
  if (missing) return `No story has the slug ${missing}.`
  return id ? `No story has the id ${id}.` : 'No stories yet.'
}

function StateFrame({
  story,
  viewport,
  choices,
  args,
}: {
  story: LaneStory
  viewport: Viewport
  choices: Choices
  args: Record<string, string>
}) {
  const src = stateUrl(story, { preview: true, switches: choices.switches, args })
  const full = viewport.width === 0
  return (
    <iframe
      key={src}
      src={src}
      title={story.id}
      data-story-frame={story.id}
      style={{
        display: 'block',
        border: 0,
        background: '#fff',
        boxShadow: full ? 'none' : '0 1px 3px rgba(0,0,0,.2)',
        width: full ? '100%' : viewport.width,
        height: full ? '100%' : viewport.height || '100%',
        flex: 'none',
      }}
    />
  )
}

function Sidebar({ selected, choices }: { selected: string | null; choices: Choices }) {
  const [filter, setFilter] = useState('')
  const groups = useMemo(() => {
    const out: { title: string; ids: string[] }[] = []
    for (const id of registry.order) {
      const story = registry.stories[id]
      const title = story.levels.join(' / ')
      if (out.length > 0 && out[out.length - 1].title === title) out[out.length - 1].ids.push(id)
      else out.push({ title, ids: [id] })
    }
    return out
  }, [])
  useEffect(() => {
    document.querySelector('nav [aria-current="page"]')?.scrollIntoView({ block: 'center' })
  }, [])
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (title: string, id: string) => {
    const text = `${title} ${registry.stories[id].name} ${id}`.toLowerCase()
    return words.every((w) => text.includes(w))
  }
  return (
    <nav style={{ ...ui, overflow: 'auto', borderRight: '1px solid #e5e7eb', padding: 8 }}>
      <input
        type="search"
        aria-label="Find a story"
        placeholder="Find a story"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '4px 8px',
          marginBottom: 8,
          font: 'inherit',
        }}
      />
      {groups.map(({ title, ids }) => {
        const visible = ids.filter((id) => shown(title, id))
        if (visible.length === 0) return null
        return (
          <details key={title} open={words.length > 0 || ids.includes(selected ?? '')}>
            <summary style={{ cursor: 'pointer', padding: '2px 0' }}>{title}</summary>
            <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 4px 12px' }}>
              {visible.map((id) => (
                <li key={id}>
                  <a
                    href={oneHref(id, choices)}
                    aria-current={id === selected ? 'page' : undefined}
                    style={{ color: 'inherit', fontWeight: id === selected ? 600 : 400 }}
                  >
                    {registry.stories[id].name}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )
      })}
    </nav>
  )
}

export default function Shell({ url }: { url: LaneUrl }) {
  const { id, together, missing } = selection(url)
  const story = id ? registry.stories[id] : undefined
  const [choices, setChoices] = useState<Choices>(() => {
    const switches: Record<string, string> = {}
    for (const s of lane.switchers) {
      const value = url.switches[s.name]
      if (value !== undefined && s.values.includes(value)) switches[s.name] = value
    }
    return { viewport: url.switches[VIEWPORT] ?? null, switches }
  })
  const viewport = viewportFor(story, choices.viewport)
  const shown = story ? laneSwitches(story, choices.switches, lane.switchers, switchDefaults) : {}
  const banner = story ? laneBanner(story.meta, lane.banners) : null
  const states = together.length > 0 ? together.flatMap((f) => registry.files[f].ids) : []
  const canTogether = story && sideBySide.has(story.file)

  useEffect(() => {
    if (story) document.title = `${story.levels.join(' / ')}: ${story.name}`
  }, [story])
  const button = (active: boolean) => ({
    font: 'inherit',
    padding: '2px 8px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    background: active ? '#1f2937' : '#fff',
    color: active ? '#fff' : 'inherit',
  })

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '18rem 1fr',
        height: '100vh',
        background: '#f3f4f6',
      }}
    >
      <Sidebar selected={id} choices={choices} />
      <main style={{ ...ui, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <header
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            padding: 8,
            background: '#fff',
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          <strong style={{ marginRight: 'auto' }}>
            {story
              ? `${story.levels.join(' / ')}: ${together.length > 0 ? 'every state' : story.name}`
              : 'Stories'}
          </strong>
          {lane.viewports.map((v) => (
            <button
              key={v.label}
              type="button"
              aria-pressed={v.label === viewport.label}
              onClick={() => setChoices({ ...choices, viewport: v.label })}
              style={button(v.label === viewport.label)}
            >
              {v.width ? `${v.label} ${v.width}` : v.label}
            </button>
          ))}
          {lane.switchers.map((s) => (
            <label key={s.name} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {s.label}
              <select
                value={shown[s.name] ?? ''}
                onChange={(e) =>
                  setChoices({
                    ...choices,
                    switches: { ...choices.switches, [s.name]: e.target.value },
                  })
                }
              >
                {s.values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {story && canTogether && together.length === 0 && (
            <a href={togetherHref(story.slug, choices)}>Side by side</a>
          )}
          {story && together.length > 0 && <a href={oneHref(story.id, choices)}>One at a time</a>}
          {story && (
            <a href={stateUrl(story, { switches: choices.switches, args: url.args })}>Open alone</a>
          )}
        </header>
        {banner && together.length === 0 && (
          <div
            role="note"
            data-story-banner={banner.tone}
            style={{
              padding: '6px 12px',
              background: banner.tone === 'warning' ? '#fef3c7' : '#dbeafe',
            }}
          >
            <strong>{banner.lead}</strong> {banner.text}
          </div>
        )}
        <section
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: viewport.width === 0 ? 0 : 16,
          }}
        >
          {!story ? (
            <p style={{ padding: 16 }}>{nothing(id, missing)}</p>
          ) : states.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
              {states.map((stateId) => (
                <figure key={stateId} style={{ margin: 0, width: viewport.width || '100%' }}>
                  <figcaption style={{ padding: '4px 0' }}>
                    <a href={oneHref(stateId, choices)}>{registry.stories[stateId].name}</a>
                  </figcaption>
                  <div style={{ height: viewport.height || '100vh' }}>
                    <StateFrame
                      story={registry.stories[stateId]}
                      viewport={viewport}
                      choices={choices}
                      args={url.args}
                    />
                  </div>
                </figure>
              ))}
            </div>
          ) : (
            <StateFrame story={story} viewport={viewport} choices={choices} args={url.args} />
          )}
        </section>
      </main>
    </div>
  )
}
```

## src/stories/Canvas.tsx

```tsx
// One state per document (massimo csf lane). The canvas reads its query once,
// sets the switch attributes on <html> before the story paints, renders the
// state inside the project's frame, and marks <html data-story-ready> once it
// has rendered. With `mode=preview` it shows no banner and no switchers: that
// is how the shell, sweeps and screenshots load it.
import {
  Component,
  type ComponentType,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react'
import {
  Frame,
  type LaneStory,
  type LaneUrl,
  lane,
  laneAttributes,
  laneBanner,
  laneProps,
  laneSwitches,
  laneWidth,
  modules,
  switchDefaults,
} from 'virtual:massimo-stories'

type Loaded = { module: Record<string, unknown> } | { error: string }

const html = () => document.documentElement
const describe = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error)

// A state that cannot render says why, and marks the document so a sweep
// reports it instead of waiting for it to be ready.
function Failed({ message }: { message: string }) {
  useEffect(() => {
    html().setAttribute('data-story-error', 'true')
  }, [])
  return (
    <pre
      role="alert"
      style={{ margin: 16, font: '13px/1.5 ui-monospace, monospace', whiteSpace: 'pre-wrap' }}
    >
      {message}
    </pre>
  )
}

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { error: describe(error) }
  }
  render() {
    return this.state.error === null ? this.props.children : <Failed message={this.state.error} />
  }
}

// Marks the document ready once the state and its own effects have run.
function Ready() {
  useEffect(() => {
    html().setAttribute('data-story-ready', 'true')
  }, [])
  return null
}

type RenderProps = {
  module: Record<string, unknown>
  story: LaneStory
  args: Record<string, string>
}

// The export with its props as Ladle gives them (args, argTypes and
// `arg-<name>` from the URL), inside the boundary so a throw shows here.
function Render({ module, story, args }: RenderProps) {
  const Story = module[story.export] as ComponentType<Record<string, unknown>> | undefined
  if (!Story) return <Failed message={`${story.file} has no export ${story.export}.`} />
  return (
    <>
      <Story {...laneProps(module, story.export, args)} />
      <Ready />
    </>
  )
}

function Banner({ story }: { story: LaneStory }) {
  const banner = laneBanner(story.meta, lane.banners)
  if (!banner) return null
  const warning = banner.tone === 'warning'
  return (
    <div
      role="note"
      data-story-banner={banner.tone}
      style={{
        margin: '8px 160px 8px 8px',
        padding: '8px 12px',
        borderRadius: 6,
        font: '13px/1.4 system-ui, sans-serif',
        background: warning ? '#fef3c7' : '#dbeafe',
        color: warning ? '#78350f' : '#1e3a8a',
      }}
    >
      <strong>{banner.lead}</strong> {banner.text}
    </div>
  )
}

export default function Canvas({ story, url }: { story: LaneStory; url: LaneUrl }) {
  const [switches, setSwitches] = useState(() =>
    laneSwitches(story, url.switches, lane.switchers, switchDefaults),
  )
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  // On mount, and again only when a viewer changes a switch outside preview mode.
  useLayoutEffect(() => {
    for (const [attribute, value] of Object.entries(laneAttributes(switches, lane.switchers))) {
      if (value === null) html().removeAttribute(attribute)
      else html().setAttribute(attribute, value)
    }
  }, [switches])

  useEffect(() => {
    const load = modules[story.file]
    if (!load) {
      setLoaded({ error: `The lane has no loader for ${story.file}.` })
      return
    }
    load().then(
      (module) => setLoaded({ module }),
      (error: unknown) => setLoaded({ error: describe(error) }),
    )
  }, [story.file])

  if (loaded === null) return null
  if ('error' in loaded) return <Failed message={loaded.error} />

  const state = (
    <Boundary>
      <Render module={loaded.module} story={story} args={url.args} />
    </Boundary>
  )
  const framed = Frame ? (
    <Frame id={story.id} meta={story.meta} switches={switches} preview={url.preview}>
      {state}
    </Frame>
  ) : (
    state
  )
  if (url.preview) return framed

  // Outside preview mode, as in Ladle: the switchers, the banner, and the
  // story's own width from `meta.width`, a number or a width name.
  const width = laneWidth(story.meta, lane.widths)
  return (
    <div data-story-width={width ?? undefined} style={width ? { width } : undefined}>
      {lane.switchers.length > 0 && (
        <div
          style={{
            position: 'fixed',
            top: 8,
            right: 8,
            zIndex: 2147483647,
            display: 'flex',
            gap: 4,
          }}
        >
          {lane.switchers.map((s) => (
            <select
              key={s.name}
              aria-label={s.label}
              value={switches[s.name] ?? ''}
              onChange={(e) => setSwitches({ ...switches, [s.name]: e.target.value })}
            >
              {s.values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}
      <Banner story={story} />
      {framed}
    </div>
  )
}
```

## src/stories/story.ts

```ts
// The types a story file imports (massimo csf lane): each state is a named
// export, and the default export holds the title. `Story<P>['argTypes']`
// types an argTypes object that several states share.
import type { ReactNode } from 'react'

export type ArgType = {
  control?: { type: string }
  options?: readonly unknown[]
  defaultValue?: unknown
  name?: string
  description?: string
}

export type Story<P = {}> = ((props: P) => ReactNode) & {
  storyName?: string
  meta?: Record<string, unknown>
  parameters?: Record<string, unknown>
  args?: Partial<P> & Record<string, unknown>
  argTypes?: Record<string, ArgType>
}

export type StoryDefault<P = {}> = {
  title: string
  meta?: Record<string, unknown>
  args?: Partial<P>
  argTypes?: Record<string, ArgType>
}
```

## src/stories/massimo.d.ts

```ts
// massimo lane types, format 1
// What `virtual:massimo-stories` holds, written by massimo's Vite plugin
// (scripts/lib/vite-stories.mjs in the massimo project folder). The first
// line names the registry format this scaffold reads, and
// `stories.mjs --check` compares it with the plugin's.

declare module 'virtual:massimo-stories' {
  import type { ComponentType, ReactNode } from 'react'

  export type LaneStory = {
    id: string
    slug: string
    state: string
    title: string | null
    levels: string[]
    name: string
    file: string
    export: string
    meta: Record<string, unknown>
    args: boolean
    argTypes: boolean
    parameters: boolean
    span: { start: number; end: number } | null
  }
  export type LaneFile = {
    title: string | null
    slug: string
    ids: string[]
    typeImport: { start: number; end: number; spec: string; names: string[] } | null
    unreadable: { story: string | null; field: string | null; detail: string }[]
  }
  export type LaneRegistry = {
    format: number
    ids: 'export' | 'ladle'
    stories: Record<string, LaneStory>
    order: string[]
    home: string | null
    slugs: Record<string, { title: string | null; files: string[]; ids: string[] }>
    files: Record<string, LaneFile>
    problems: { rule: string; file: string | null; detail: string }[]
  }
  export type Viewport = { label: string; width: number; height: number }
  export type Switcher = {
    name: string
    label: string
    attribute: string | null
    values: string[]
    unset: string | null
    default: string | null
  }
  export type LaneSettings = {
    home: string | null
    viewports: Viewport[]
    widths: Record<string, number>
    switchers: Switcher[]
    banners: Record<string, { tone: string; lead: string }>
    sideBySide: string[]
  }
  export type LaneUrl = {
    kind: 'index' | 'slug' | 'state' | 'legacy' | 'legacy-preview' | 'missing'
    slug: string | null
    state: string | null
    selected: string | null
    preview: boolean
    switches: Record<string, string>
    args: Record<string, string>
    oldId: string | null
  }
  export type FrameProps = {
    id: string
    meta: Record<string, unknown>
    switches: Record<string, string | null>
    preview: boolean
    children: ReactNode
  }
  export type SwitchDefaults = (id: string, meta: Record<string, unknown>) => Record<string, string>

  export const format: number
  export const registry: LaneRegistry
  export const lane: LaneSettings
  export const modules: Record<string, () => Promise<Record<string, unknown>>>
  export const Frame: ComponentType<FrameProps> | null
  export const switchDefaults: SwitchDefaults | null

  export function parseLaneUrl(pathname: string, search: string): LaneUrl
  export function stateUrl(
    entry: { slug: string; state: string } | null | undefined,
    options?: {
      preview?: boolean
      switches?: Record<string, string | null | undefined>
      args?: Record<string, unknown>
    },
  ): string
  export function shellUrl(id: string): string
  export function orderIds(ids: string[], order: string[] | null): string[]
  export function argsFromSearch(search: string): Record<string, string>

  export function laneBanner(
    meta: Record<string, unknown> | null | undefined,
    banners: LaneSettings['banners'],
  ): { key: string; tone: string; lead: string; text: string } | null
  export function laneSwitches(
    story: LaneStory | null,
    query: Record<string, string>,
    switchers: Switcher[],
    defaults: SwitchDefaults | null,
  ): Record<string, string | null>
  export function laneWidth(
    meta: Record<string, unknown> | null | undefined,
    widths: LaneSettings['widths'],
  ): number | null
  export function laneAttributes(
    values: Record<string, string | null>,
    switchers: Switcher[],
  ): Record<string, string | null>
  export function laneProps(
    module: Record<string, unknown>,
    name: string,
    urlArgs: Record<string, string>,
  ): Record<string, unknown>
}
```

## src/stories/frame.tsx

```tsx
// The frame every state renders in (massimo csf lane), named by
// `stories.frame`. Project-owned: give it what the app's root gives every
// page, such as providers, the page surface and the classes old selectors
// wait on. It gets the state's id, its merged meta, the switch values and
// whether the canvas is in preview mode.
import type { FrameProps } from 'virtual:massimo-stories'

export default function Frame({ children }: FrameProps) {
  return <div className="min-h-screen">{children}</div>
}
```

Port the old tool's global provider here: the page surface and the wrapper classes old specs wait on (the canvas adds `data-story-ready`, so new specs can wait on that), fonts loaded on mount, providers every page has. The banner and the switchers are the lane's own now. When a switch's default depends on the state, export `switchDefaults` beside the frame:

```tsx
// The skin a state opens with when the viewer has not picked one.
export function switchDefaults(id: string, _meta: Record<string, unknown>) {
  return { skin: id.includes('--checkout--') ? 'plain' : 'brand' }
}
```

## CSS

The lane imports the app's base CSS (`stories.appCss.base`) and never the app's entry that holds `@source not` lines (`stories.appCss.entry`): an exclusion anywhere in the imported files wins over a positive `@source` for the same path, so the lane would lose its own classes. When the app keeps story files, story-only modules and the lane's own `src/stories/` out of its CSS, it does so in a separate entry file, `@import "./index.css";` plus the `@source not` lines, which the app's main module imports instead of the base; `stories.mjs --check` refuses a base that holds `@source not`.

`src/stories/stories.css`:

```css
/* The lane's CSS (massimo csf lane). It imports the app's base CSS, never the
   app's entry that holds `@source not`: an exclusion anywhere in the imported
   files wins over the lines below. */
@import "../index.css";
@import "./stories.extra.css";

/* Files only stories use, so their classes are generated for the lane. */
@source "../**/*.stories.{tsx,ts}";
@source "./";
```

Point the first import at `stories.appCss.base`. Add a `@source` line for each story-only module whose name no line covers, such as harnesses and shared story helpers (`stories.mjs leak` lists them in the edit it prints, and once `stories.appCss.entry` is set, `--check` warns on each one the entry does not exclude).

`src/stories/stories.extra.css`:

```css
/* Rules the lane needs and the app must never ship (massimo csf lane), such
   as the page surface behind every state. */
html,
body {
  background-color: #fff;
}
```

Move here the rules the old tool's stylesheet held only for stories, such as the page surface, harness rules and screenshot aids. Drop rules for the old tool's own chrome, since the lane's chrome lives outside the story's document, and every rule the old stylesheet mirrored from the app's: the import above brings the real ones.

## package.json

```json
"ds:stories": "vite --config vite.stories.config.ts",
"ds:stories:build": "vite build --config vite.stories.config.ts"
```

## tsconfig

Add `src/stories/**/*` to the `include` of the tsconfig that checks the story files (for a Ladle repo, the one that included `.ladle/**/*.tsx`), so the lane files, `massimo.d.ts` and `story.ts` are typechecked with the stories. A tsconfig that already includes all of `src` covers them.

## .gitignore

The output folder must be ignored before the first build: `git check-ignore -q <outDir>/index.html` exits 0 when it is. If it is not, add the line (`dist-stories/`) and say so; when it already is, say that instead.

## Prove it

- `npm run typecheck` (or the repo's `tsc` step), and the repo's linter on the new files.
- `node <project>/scripts/stories.mjs --check`: 0 problems.
- `npm run ds:stories`, then load `/stories`, one canvas (`/stories/<slug>/<state>`) and one old link (`/?story=<id>&mode=preview`); each reaches `html[data-story-ready]` with no console error.
- `npm run ds:stories:build`: the output folder holds `index.html`, `meta.json` and the chunks, a `_redirects` with only the `/stories/*` line when asked, and no `_headers` from the app.

## Leak check

```bash
npm run build && npm run ds:stories:build
node <project>/scripts/stories.mjs leak --app dist --lane dist-stories
```

Use the app's real build output folder if it is not `dist`. It fails when a class found only in story files, story-only modules and the lane's scaffold folder (the folder of the module script `stories.html` loads) reaches the app's CSS, and prints the CSS edit that keeps them out, the scaffold folder as one line, with every path written from the entry CSS it names. `leak` refuses an output folder git does not ignore.

The scan goes by words, so a class that a package's stylesheet or a CSS plugin gives the app, under a name only stories use, shows up too. Settle one with a probe: add a story-only class to a story, rebuild both, and run `leak --probe '<class>'`, which passes when the class is in the lane's CSS and not the app's. After moving the exclusions, keep the app build from before the move and run `leak --before <that folder>`: it lists every class the app's CSS dropped, grouped by where its name occurs, and fails if an app file uses one. Put the list in the CSS change for review: app code that builds a class name at run time, such as `` `gap-${n}` ``, needs a class it never names, so the check cannot see that loss, and the class shows in the list under whichever files did name it.

## Gotchas

- `Invalid hook call` in a worktree means two copies of React: the plugin pins React to the install root, so check that the lane's config does not alias React again.
- A story that imports through an alias the app's Vite config sets by hand, and no tsconfig `paths` declares, fails to resolve: add the alias to the lane's config, or to `paths`.
- A harness that writes the page URL (`history.replaceState`) writes the canvas's, which is its own document; the shell is untouched.
- `parameters` and story-level `args` stay as they are: the canvas reads `args` at run time and ignores `parameters`.
