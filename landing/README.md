# aizuchi.tools — landing page

Static marketing site for [Aizuchi](https://github.com/StephenSHorton/aizuchi).
Astro + React + Tailwind v4. Deploys to Vercel.

## Develop

```sh
bun install
bun run dev
```

Open [http://127.0.0.1:4321](http://127.0.0.1:4321).

## Build

```sh
bun run build       # outputs to ./dist
bun run preview     # serve the build locally
bun run check       # astro type / a11y check
```

## Deploy

Vercel project root: `landing/` (this directory). No additional config —
Astro is auto-detected, output is `static`.
