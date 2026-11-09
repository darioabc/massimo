import FrameModule, { switchDefaults as frameSwitchDefaults } from "/src/stories/frame.tsx"
// virtual:massimo-stories, written by massimo's Vite plugin: the lane's registry,
// its settings, one loader per story file, the route helpers and the view helpers.

// The lane's URLs, shared by the Vite plugin, the shell and the canvas. This
// module imports nothing, because the plugin inlines its text into the
// virtual module the browser loads.
//
//   index            /  or  /stories       (`?s=<id>` selects a state in the shell)
//   slug             /stories/<slug>
//   state            /stories/<slug>/<state>
//   legacy           /?story=<id>
//   legacy-preview   /?story=<id>&mode=preview
//
// Every URL may carry `mode=preview`, switches as `<name>=<value>`, and
// Ladle's args as `arg-<name>=<value>`.

// Query keys that are never a switch.
const RESERVED = new Set(['story', 'mode', 's'])

const decodeSegment = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

// What a URL asks for, as { kind, slug, state, selected, preview, switches,
// args, oldId }. `selected` is the shell's `?s=<id>`, `oldId` the id a
// legacy URL names, `switches` every query key that is not reserved or an
// arg, and `args` Ladle's `arg-<name>` values as strings. A path the lane
// does not serve is `missing`.
export function parseLaneUrl(pathname, search) {
  const params = new URLSearchParams(search ?? '')
  const out = { kind: 'missing', slug: null, state: null, selected: params.get('s'), preview: params.get('mode') === 'preview', switches: {}, args: argsFromSearch(search), oldId: null }
  for (const [key, value] of params) if (!RESERVED.has(key) && !key.startsWith('arg-')) out.switches[key] = value
  const path = (pathname || '/').replace(/\/+$/, '') || '/'
  if (path === '/' || path === '/index.html') {
    const story = params.get('story')
    if (story) {
      out.kind = out.preview ? 'legacy-preview' : 'legacy'
      out.oldId = story
    } else out.kind = 'index'
    return out
  }
  if (path === '/stories') {
    out.kind = 'index'
    return out
  }
  const m = /^\/stories\/([^/]+)(?:\/([^/]+))?$/.exec(path)
  if (!m) return out
  const slug = decodeSegment(m[1])
  const state = m[2] === undefined ? null : decodeSegment(m[2])
  if (slug === null || (m[2] !== undefined && state === null)) return out
  out.kind = state === null ? 'slug' : 'state'
  out.slug = slug
  out.state = state
  return out
}

// The canvas URL of a registry entry, or '' for an entry with no slug or
// state. Arg values are written as Ladle writes them: a string as it is, any
// other value as JSON, each through encodeURI.
export function stateUrl(entry, { preview = false, switches = {}, args = {} } = {}) {
  if (!entry?.slug || !entry?.state) return ''
  const path = `/stories/${encodeURIComponent(entry.slug)}/${encodeURIComponent(entry.state)}`
  const params = new URLSearchParams()
  if (preview) params.set('mode', 'preview')
  for (const [name, value] of Object.entries(switches ?? {})) if (value !== null && value !== undefined) params.set(name, String(value))
  for (const [name, value] of Object.entries(args ?? {})) params.set(`arg-${name}`, encodeURI(typeof value === 'string' ? value : JSON.stringify(value)))
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

// The shell URL that selects one state.
export function shellUrl(id) {
  return `/stories?s=${encodeURIComponent(id)}`
}

// `ids` in the order `order` gives, in Ladle's storyOrder form: an entry
// with `*` takes every id that starts with the text before its first `*`,
// any other entry the one id it names, and an id already placed stays where
// it is. The ids no entry takes follow, as they came (Ladle drops them).
export function orderIds(ids, order) {
  if (!order || order.length === 0) return [...ids]
  const placed = new Set()
  for (const entry of order) {
    const pattern = String(entry).toLowerCase()
    const star = pattern.indexOf('*')
    for (const id of ids) {
      if (!placed.has(id) && (star === -1 ? id === pattern : id.startsWith(pattern.slice(0, star)))) placed.add(id)
    }
  }
  return [...placed, ...ids.filter((id) => !placed.has(id))]
}

// Ladle's `arg-<name>=<value>` pairs from a query string, as { name: value }
// with each value a string, decoded as Ladle decodes it. The name is all of
// the key after `arg-`.
export function argsFromSearch(search) {
  const out = {}
  for (const [key, value] of new URLSearchParams(search ?? '')) {
    if (!key.startsWith('arg-') || key.length === 4) continue
    let decoded = value
    try {
      decoded = decodeURI(value)
    } catch {
      // a lone `%` stays as it is
    }
    out[key.slice(4)] = decoded
  }
  return out
}

export function laneBanner(meta, banners) {
  for (const [key, banner] of Object.entries(banners ?? {})) {
    const text = meta ? meta[key] : undefined
    if (typeof text === 'string' && text.trim() !== '') return { key, tone: banner?.tone ?? 'info', lead: banner?.lead ?? '', text }
  }
  return null
}

export function laneSwitches(story, query, switchers, defaults) {
  const out = {}
  let fromFrame = null
  for (const s of switchers ?? []) {
    const values = s.values ?? []
    const allowed = (v) => typeof v === 'string' && values.includes(v)
    let value = allowed(query?.[s.name]) ? query[s.name] : allowed(s.default) ? s.default : null
    if (value === null && typeof defaults === 'function' && story) {
      fromFrame ??= defaults(story.id, story.meta ?? {}) ?? {}
      if (allowed(fromFrame[s.name])) value = fromFrame[s.name]
    }
    out[s.name] = value ?? s.unset ?? values[0] ?? null
  }
  return out
}

export function laneWidth(meta, widths) {
  let width = meta ? meta.width : undefined
  if (typeof width === 'string' && widths && Object.prototype.hasOwnProperty.call(widths, width)) width = widths[width]
  return typeof width === 'number' && width > 0 ? width : null
}

export function laneAttributes(values, switchers) {
  const out = {}
  for (const s of switchers ?? []) {
    if (!s.attribute) continue
    const value = values?.[s.name] ?? null
    out[s.attribute] = value === null || value === s.unset ? null : value
  }
  return out
}

export function laneProps(module, name, urlArgs) {
  const story = module ? module[name] : undefined
  const file = (module && module.default) || {}
  const args = { ...(file.args || {}), ...((story && story.args) || {}) }
  const argTypes = { ...(file.argTypes || {}), ...((story && story.argTypes) || {}) }
  const controls = {}
  for (const [key, value] of Object.entries(args)) {
    const kind = typeof value
    const type = kind === 'function' || kind === 'boolean' || kind === 'number' || kind === 'string' ? kind : 'complex'
    controls[key] = { type, value }
  }
  for (const [key, argType] of Object.entries(argTypes)) {
    if (argType && argType.action) {
      controls[key] = { type: 'action', value: (...event) => console.info(`action: ${key}`, ...event) }
      continue
    }
    if (!argType || !argType.control || !argType.control.type) throw new Error('argTypes should have control type specified')
    controls[key] = { type: argType.control.type, options: argType.options, value: args[key] === undefined ? argType.defaultValue : args[key] }
  }
  const fromOptions = (value, options) => {
    if (options && options.some((option) => option === Number(value))) return Number(value)
    return value === 'true' ? true : value === 'false' ? false : value
  }
  const json = (value) => {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  for (const [param, raw] of Object.entries(urlArgs || {})) {
    // Ladle reads the name up to the first hyphen.
    const control = controls[param.split('-')[0]]
    if (!control || control.type === 'action') continue
    const type = control.type
    if (type === 'boolean') control.value = raw === 'true'
    else if (type === 'range') control.value = Number.parseFloat(raw)
    else if (type === 'number') control.value = Number.parseInt(raw, 10)
    else if (type === 'complex') control.value = json(raw)
    else if (type === 'radio' || type === 'inline-radio' || type === 'select' || type === 'background') control.value = fromOptions(raw, control.options)
    else if (type === 'check' || type === 'inline-check' || type === 'multi-select') control.value = fromOptions(json(raw), control.options)
    else control.value = raw
  }
  const props = {}
  for (const [key, control] of Object.entries(controls)) {
    const mapping = argTypes[key] && argTypes[key].mapping
    const mapped = (v) => (mapping && Object.prototype.hasOwnProperty.call(mapping, v) ? mapping[v] : v)
    props[key] = Array.isArray(control.value) ? control.value.map(mapped) : mapped(control.value)
  }
  return props
}

export const format = 1

export const registry = {
  "format": 1,
  "ids": "ladle",
  "stories": {
    "foundations--welcome--start-here": {
      "id": "foundations--welcome--start-here",
      "slug": "foundations--welcome",
      "state": "start-here",
      "title": "Foundations / Welcome",
      "levels": [
        "Foundations",
        "Welcome"
      ],
      "name": "Start here",
      "file": "src/Welcome.stories.tsx",
      "export": "StartHere",
      "meta": {},
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 5,
        "end": 10
      }
    },
    "primitives--actions--button--primary": {
      "id": "primitives--actions--button--primary",
      "slug": "primitives--actions--button",
      "state": "primary",
      "title": "Primitives / Actions / Button",
      "levels": [
        "Primitives",
        "Actions",
        "Button"
      ],
      "name": "Primary",
      "file": "src/components/Button.stories.tsx",
      "export": "Primary",
      "meta": {},
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 6,
        "end": 6
      }
    },
    "primitives--actions--button--log--in-button": {
      "id": "primitives--actions--button--log--in-button",
      "slug": "primitives--actions--button",
      "state": "log--in-button",
      "title": "Primitives / Actions / Button",
      "levels": [
        "Primitives",
        "Actions",
        "Button"
      ],
      "name": "Log-In button",
      "file": "src/components/Button.stories.tsx",
      "export": "LogIn",
      "meta": {
        "width": 375
      },
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 9,
        "end": 9
      }
    },
    "primitives--actions--button--sized": {
      "id": "primitives--actions--button--sized",
      "slug": "primitives--actions--button",
      "state": "sized",
      "title": "Primitives / Actions / Button",
      "levels": [
        "Primitives",
        "Actions",
        "Button"
      ],
      "name": "Sized",
      "file": "src/components/Button.stories.tsx",
      "export": "Sized",
      "meta": {},
      "args": true,
      "argTypes": true,
      "parameters": false,
      "span": {
        "start": 13,
        "end": 15
      }
    },
    "patterns--cards--card--plain": {
      "id": "patterns--cards--card--plain",
      "slug": "patterns--cards--card",
      "state": "plain",
      "title": "Patterns / Cards / Card",
      "levels": [
        "Patterns",
        "Cards",
        "Card"
      ],
      "name": "Plain",
      "file": "src/components/Card.stories.tsx",
      "export": "Plain",
      "meta": {},
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 6,
        "end": 6
      }
    },
    "patterns--cards--card--with-footer": {
      "id": "patterns--cards--card--with-footer",
      "slug": "patterns--cards--card",
      "state": "with-footer",
      "title": "Patterns / Cards / Card",
      "levels": [
        "Patterns",
        "Cards",
        "Card"
      ],
      "name": "With footer",
      "file": "src/components/Card.stories.tsx",
      "export": "WithFooter",
      "meta": {
        "drift": "The footer gap is 12px here and 16px in the design."
      },
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 8,
        "end": 10
      }
    },
    "patterns--gauge--editor--empty": {
      "id": "patterns--gauge--editor--empty",
      "slug": "patterns--gauge--editor",
      "state": "empty",
      "title": "Patterns / Gauge / Editor",
      "levels": [
        "Patterns",
        "Gauge",
        "Editor"
      ],
      "name": "Empty",
      "file": "src/components/gauge/Editor.stories.tsx",
      "export": "Empty",
      "meta": {},
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 6,
        "end": 6
      }
    },
    "patterns--gauge--editor--five-steps": {
      "id": "patterns--gauge--editor--five-steps",
      "slug": "patterns--gauge--editor",
      "state": "five-steps",
      "title": "Patterns / Gauge / Editor",
      "levels": [
        "Patterns",
        "Gauge",
        "Editor"
      ],
      "name": "Five steps",
      "file": "src/components/gauge/Editor.stories.tsx",
      "export": "FiveSteps",
      "meta": {},
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 8,
        "end": 8
      }
    },
    "explorations--new-header--wide": {
      "id": "explorations--new-header--wide",
      "slug": "explorations--new-header",
      "state": "wide",
      "title": "Explorations / New header",
      "levels": [
        "Explorations",
        "New header"
      ],
      "name": "Wide",
      "file": "src/explorations/NewHeader.stories.tsx",
      "export": "Wide",
      "meta": {
        "exploration": "A taller header with the search field inline, kept for the next review."
      },
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 8,
        "end": 13
      }
    },
    "explorations--new-header--narrow": {
      "id": "explorations--new-header--narrow",
      "slug": "explorations--new-header",
      "state": "narrow",
      "title": "Explorations / New header",
      "levels": [
        "Explorations",
        "New header"
      ],
      "name": "Narrow",
      "file": "src/explorations/NewHeader.stories.tsx",
      "export": "Narrow",
      "meta": {
        "exploration": "A taller header with the search field inline, kept for the next review.",
        "width": 375
      },
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 15,
        "end": 19
      }
    },
    "pages--review--summary--side-by-side": {
      "id": "pages--review--summary--side-by-side",
      "slug": "pages--review--summary",
      "state": "side-by-side",
      "title": "Pages / Review / Summary",
      "levels": [
        "Pages",
        "Review",
        "Summary"
      ],
      "name": "Side by side",
      "file": "src/pages/review/Compare.stories.tsx",
      "export": "SideBySide",
      "meta": {},
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 6,
        "end": 11
      }
    },
    "pages--review--summary--overview": {
      "id": "pages--review--summary--overview",
      "slug": "pages--review--summary",
      "state": "overview",
      "title": "Pages / Review / Summary",
      "levels": [
        "Pages",
        "Review",
        "Summary"
      ],
      "name": "Overview",
      "file": "src/pages/review/Summary.stories.tsx",
      "export": "Overview",
      "meta": {},
      "args": false,
      "argTypes": false,
      "parameters": true,
      "span": {
        "start": 7,
        "end": 7
      }
    },
    "pages--review--summary--state-b--admin": {
      "id": "pages--review--summary--state-b--admin",
      "slug": "pages--review--summary",
      "state": "state-b--admin",
      "title": "Pages / Review / Summary",
      "levels": [
        "Pages",
        "Review",
        "Summary"
      ],
      "name": "State b admin",
      "file": "src/pages/review/Summary.stories.tsx",
      "export": "StateB_Admin",
      "meta": {},
      "args": false,
      "argTypes": false,
      "parameters": false,
      "span": {
        "start": 11,
        "end": 11
      }
    }
  },
  "order": [
    "foundations--welcome--start-here",
    "primitives--actions--button--primary",
    "primitives--actions--button--log--in-button",
    "primitives--actions--button--sized",
    "patterns--cards--card--plain",
    "patterns--cards--card--with-footer",
    "patterns--gauge--editor--empty",
    "patterns--gauge--editor--five-steps",
    "pages--review--summary--side-by-side",
    "pages--review--summary--overview",
    "pages--review--summary--state-b--admin",
    "explorations--new-header--wide",
    "explorations--new-header--narrow"
  ],
  "home": "foundations--welcome--start-here",
  "slugs": {
    "foundations--welcome": {
      "title": "Foundations / Welcome",
      "files": [
        "src/Welcome.stories.tsx"
      ],
      "ids": [
        "foundations--welcome--start-here"
      ]
    },
    "primitives--actions--button": {
      "title": "Primitives / Actions / Button",
      "files": [
        "src/components/Button.stories.tsx"
      ],
      "ids": [
        "primitives--actions--button--primary",
        "primitives--actions--button--log--in-button",
        "primitives--actions--button--sized"
      ]
    },
    "patterns--cards--card": {
      "title": "Patterns / Cards / Card",
      "files": [
        "src/components/Card.stories.tsx"
      ],
      "ids": [
        "patterns--cards--card--plain",
        "patterns--cards--card--with-footer"
      ]
    },
    "patterns--gauge--editor": {
      "title": "Patterns / Gauge / Editor",
      "files": [
        "src/components/gauge/Editor.stories.tsx"
      ],
      "ids": [
        "patterns--gauge--editor--empty",
        "patterns--gauge--editor--five-steps"
      ]
    },
    "explorations--new-header": {
      "title": "Explorations / New header",
      "files": [
        "src/explorations/NewHeader.stories.tsx"
      ],
      "ids": [
        "explorations--new-header--wide",
        "explorations--new-header--narrow"
      ]
    },
    "pages--review--summary": {
      "title": "Pages / Review / Summary",
      "files": [
        "src/pages/review/Compare.stories.tsx",
        "src/pages/review/Summary.stories.tsx"
      ],
      "ids": [
        "pages--review--summary--side-by-side",
        "pages--review--summary--overview",
        "pages--review--summary--state-b--admin"
      ]
    }
  },
  "files": {
    "src/Welcome.stories.tsx": {
      "title": "Foundations / Welcome",
      "slug": "foundations--welcome",
      "ids": [
        "foundations--welcome--start-here"
      ],
      "typeImport": {
        "start": 0,
        "end": 41,
        "spec": "@ladle/react",
        "names": [
          "Story"
        ]
      },
      "unreadable": []
    },
    "src/components/Button.stories.tsx": {
      "title": "Primitives / Actions / Button",
      "slug": "primitives--actions--button",
      "ids": [
        "primitives--actions--button--primary",
        "primitives--actions--button--log--in-button",
        "primitives--actions--button--sized"
      ],
      "typeImport": {
        "start": 0,
        "end": 41,
        "spec": "@ladle/react",
        "names": [
          "Story"
        ]
      },
      "unreadable": []
    },
    "src/components/Card.stories.tsx": {
      "title": "Patterns / Cards / Card",
      "slug": "patterns--cards--card",
      "ids": [
        "patterns--cards--card--plain",
        "patterns--cards--card--with-footer"
      ],
      "typeImport": {
        "start": 0,
        "end": 41,
        "spec": "@ladle/react",
        "names": [
          "Story"
        ]
      },
      "unreadable": []
    },
    "src/components/gauge/Editor.stories.tsx": {
      "title": "Patterns / Gauge / Editor",
      "slug": "patterns--gauge--editor",
      "ids": [
        "patterns--gauge--editor--empty",
        "patterns--gauge--editor--five-steps"
      ],
      "typeImport": {
        "start": 0,
        "end": 41,
        "spec": "@ladle/react",
        "names": [
          "Story"
        ]
      },
      "unreadable": []
    },
    "src/explorations/NewHeader.stories.tsx": {
      "title": "Explorations / New header",
      "slug": "explorations--new-header",
      "ids": [
        "explorations--new-header--wide",
        "explorations--new-header--narrow"
      ],
      "typeImport": {
        "start": 0,
        "end": 55,
        "spec": "@ladle/react",
        "names": [
          "Story",
          "StoryDefault"
        ]
      },
      "unreadable": []
    },
    "src/pages/review/Compare.stories.tsx": {
      "title": "Pages / Review / Summary",
      "slug": "pages--review--summary",
      "ids": [
        "pages--review--summary--side-by-side"
      ],
      "typeImport": {
        "start": 0,
        "end": 41,
        "spec": "@ladle/react",
        "names": [
          "Story"
        ]
      },
      "unreadable": []
    },
    "src/pages/review/Summary.stories.tsx": {
      "title": "Pages / Review / Summary",
      "slug": "pages--review--summary",
      "ids": [
        "pages--review--summary--overview",
        "pages--review--summary--state-b--admin"
      ],
      "typeImport": {
        "start": 0,
        "end": 41,
        "spec": "@ladle/react",
        "names": [
          "Story"
        ]
      },
      "unreadable": []
    }
  },
  "problems": []
}

export const lane = {
  "home": "foundations--welcome--start-here",
  "viewports": [
    {
      "label": "Phone",
      "width": 375,
      "height": 812
    },
    {
      "label": "Full",
      "width": 0,
      "height": 0
    }
  ],
  "widths": {
    "xsmall": 414,
    "small": 640,
    "medium": 768,
    "large": 1024,
    "Phone": 375
  },
  "switchers": [
    {
      "name": "scheme",
      "label": "Mode",
      "attribute": "data-theme",
      "values": [
        "auto",
        "light",
        "dark"
      ],
      "unset": "auto",
      "default": "auto"
    },
    {
      "name": "density",
      "label": "Density",
      "attribute": "data-density",
      "values": [
        "roomy",
        "compact"
      ],
      "unset": "roomy",
      "default": null
    }
  ],
  "banners": {
    "exploration": {
      "tone": "warning",
      "lead": "Exploration."
    },
    "drift": {
      "tone": "info",
      "lead": "Out of step."
    }
  },
  "sideBySide": [
    "src/components/Button.stories.tsx"
  ]
}

export const modules = {
  "src/Welcome.stories.tsx": () => import("/src/Welcome.stories.tsx"),
  "src/components/Button.stories.tsx": () => import("/src/components/Button.stories.tsx"),
  "src/components/Card.stories.tsx": () => import("/src/components/Card.stories.tsx"),
  "src/components/gauge/Editor.stories.tsx": () => import("/src/components/gauge/Editor.stories.tsx"),
  "src/explorations/NewHeader.stories.tsx": () => import("/src/explorations/NewHeader.stories.tsx"),
  "src/pages/review/Compare.stories.tsx": () => import("/src/pages/review/Compare.stories.tsx"),
  "src/pages/review/Summary.stories.tsx": () => import("/src/pages/review/Summary.stories.tsx"),
}

export const Frame = FrameModule
export const switchDefaults = frameSwitchDefaults
