# Audiospan documentation site

An [Astro Starlight](https://starlight.astro.build) site. Pages live in `src/content/docs/` as Markdown with a `title` and `description` in the frontmatter; the landing page (`index.mdx`) overrides Starlight's `Hero` with `src/components/Hero.astro`, which places `src/components/LiveDemo.tsx` (a React island on `@audiospan/react` running the reference gain plugin) beside the copy, and the API reference is generated from the workspace packages with TypeDoc at build time.

```sh
pnpm install                 # from the repository root
pnpm build                   # the packages (the demo and the API reference use them)
pnpm build:wasm gain-cpp     # the plugin the live demo loads (needs emcc)
pnpm docs:dev                # http://localhost:4321/audiospan/
pnpm docs:build              # static site in apps/docs/dist/
```

- `DOCS_NO_API=1` skips the TypeDoc step for a faster build that does not need built packages.
- The API reference uses TypeDoc's `packages` strategy: each workspace package has a `typedoc.json` naming its entry file and excluding declarations that come from a sibling's `dist/` (so re-exports are documented once, in their own package). Entry pages are generated as `index.md`; `integrations/typedoc-fixups.mjs` drops the `index/` segment starlight-typedoc leaves in links to them.
- `DOCS_SITE` and `DOCS_BASE` override the GitHub Pages defaults (`https://luebelein96.github.io` + `/audiospan`).
- Links between pages are relative (`../getting-started/`), so they work under any base. Headings get GitHub-style anchors.
- `.github/workflows/docs.yml` builds and deploys the site to GitHub Pages on every push to `main`.
- `tests/browser/docs.spec.ts` (part of `pnpm test:browser`) drives the landing-page demo in headless Chromium against `apps/docs/dist`, served under the base by `tests/browser/serve-docs.mjs`; it skips when the site is not built.
