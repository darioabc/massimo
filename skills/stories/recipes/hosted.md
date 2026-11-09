# Recipe: hosting a csf lane

For a csf lane (see `vite-csf.md`) that a team wants to open from a link: the lane's static build, served by any host that serves files. massimo ships no deploy template, since the deploy belongs to the repo's own CI and host. This page says what the build holds, what the host must do with it, and which checks run before it goes up.

## The build

```bash
npm run ds:stories:build
```

This builds into `stories.outDir`, `dist-stories` when unset. The output folder holds:

```text
index.html     the lane's entry, written from stories.html
meta.json      every state in the shape of Ladle's own meta.json
_redirects     only when stories.hostFiles lists "_redirects"; one line: /stories/* /index.html 200
assets/        the built chunks: JavaScript (one per story file, plus shared chunks and the entry), CSS and fonts
<public files> the app's public folder, copied as Vite copies it
```

There is no `_headers` file. The build leaves out an app `_redirects` or `_headers` that sits in the public folder, and warns for each: the app's rules would otherwise apply to the lane. `stories.hostFiles` supports `_redirects` only; any other name there warns.

The public folder is copied whole, so whatever it holds is published with the gallery. Look at the folder's listing before the first deploy.

## The rewrite

`/` and `/index.html` are the entry file, `/meta.json` and everything under `/assets/` are files, and `/stories`, `/stories/<slug>` and `/stories/<slug>/<state>` are routes with no file behind them. The host must answer those routes with `index.html`, and nothing else.

The rewrite is `/stories/* /index.html 200` and no wider. A host such as Cloudflare Pages applies a rewrite even when a file matches, so a catch-all `/*` would serve `meta.json` and the chunks as HTML. For another host, write the same rule in its own form: a path under `/stories/` gets `index.html` with status 200.

## Headers

The build writes none, so set them in the host's own configuration:

- `frame-ancestors 'self'` in the `Content-Security-Policy`, and `X-Frame-Options: SAMEORIGIN`. The shell shows each state in an iframe of its own origin, so framing by the same origin must work and framing by any other can be refused.
- No `'unsafe-eval'` in `script-src`, unless the app needs it.
- Access control stays at the edge: the host's access policy, a login in front of the site or a private network. The gallery has no sign-in of its own, and the recipe's `stories.html` carries `noindex` only as a hint to crawlers.

## Before it goes up

1. The output folder is ignored by git, so a build never reaches a commit: `git check-ignore -q dist-stories/index.html` exits 0 when it is.
2. Build the app and the lane, then run the leak check:

   ```bash
   npm run build && npm run ds:stories:build
   node <project>/scripts/stories.mjs leak --app dist --lane dist-stories
   ```

   Use the app's real output folder and `stories.outDir` if they differ. `leak` fails when a class used only by stories has reached the app's CSS, and refuses an output folder git does not ignore. The `vite-csf.md` leak section has the probe and the `--before` form.
3. `node <project>/scripts/stories.mjs --check` reports 0 problems.

## Prove it

On the deployed site:

- `/stories` loads the shell, and reloading a state's URL, `/stories/<slug>/<state>`, loads that canvas (the rewrite works).
- `/meta.json` is JSON and a file under `/assets/` is not HTML (the rewrite is no wider than `/stories/*`).
- An old link, `/?story=<id>&mode=preview`, renders that state in place.
- The response for a canvas carries the frame headers above, and a page on another origin cannot frame it.

## CI

`design-system-shadow.yml` has a step for this: for a csf lane it runs the check, both builds and the leak check on pull requests, allowed to fail like the rest of that job. The deploy itself stays in the repo's own workflow.
