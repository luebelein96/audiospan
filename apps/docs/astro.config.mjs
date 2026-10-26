// @ts-check
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
import typedocFixups from "./integrations/typedoc-fixups.mjs";
import rehypeLongCode from "./plugins/rehype-long-code.mjs";

const REPO = "https://github.com/luebelein96/audiospan";

// GitHub Pages project site by default. For another host set both, e.g.
// DOCS_SITE=https://docs.example.com DOCS_BASE=/ pnpm docs:build
const site = process.env.DOCS_SITE ?? "https://luebelein96.github.io";
const base = process.env.DOCS_BASE ?? "/audiospan";

// DOCS_NO_API=1 skips the TypeDoc-generated API reference. Generating it needs
// the packages built first (`pnpm build`), because cross-package types resolve
// through each package's dist/.
const withApi = !process.env.DOCS_NO_API;

const packages = ["manifest", "runtime", "sdk", "ui", "react", "cli"];

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: "Audiospan",
      description:
        "Build audio plugins for the web: C++ or Rust DSP compiled to WebAssembly, running in an AudioWorklet through one typed host API.",
      logo: { src: "./src/assets/logo.svg", alt: "Audiospan" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/apps/docs/` },
      lastUpdated: true,
      customCss: ["@fontsource-variable/inter", "@fontsource-variable/jetbrains-mono", "./src/styles/custom.css"],
      components: { Hero: "./src/components/Hero.astro" },
      plugins: withApi
        ? [
            starlightTypeDoc({
              entryPoints: packages.map((name) => `../../packages/${name}`),
              tsconfig: "./tsconfig.typedoc.json",
              output: "api",
              sidebar: { label: "API reference", collapsed: true },
              typeDoc: {
                // One module per workspace package; each package names its entry file in typedoc.json.
                entryPointStrategy: "packages",
                name: "API reference",
                // Entry pages as index.md so Starlight serves them at <package>/ (see integrations/typedoc-fixups.mjs).
                entryFileName: "index.md",
                excludePrivate: true,
                excludeInternal: true,
                gitRevision: "main",
                sourceLinkTemplate: `${REPO}/blob/{gitRevision}/{path}#L{line}`,
              },
            }),
          ]
        : [],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Getting started", slug: "getting-started" },
            { label: "From your DSP to a web app", slug: "from-dsp-to-web" },
            { label: "Troubleshooting", slug: "troubleshooting" },
            { label: "Browser support", slug: "browser-support" },
          ],
        },
        {
          label: "Writing plugins",
          items: [
            { label: "Porting existing DSP", slug: "porting-dsp" },
            { label: "C++ plugins", slug: "plugin-authoring" },
            { label: "Rust plugins", slug: "rust-plugin-authoring" },
            { label: "Real-time safety", slug: "realtime-safety" },
            { label: "Manifest schema", slug: "manifest-schema" },
          ],
        },
        {
          label: "Building apps",
          items: [
            { label: "Web app integration", slug: "web-app-integration" },
            { label: "Host integration (SDK)", slug: "host-integration" },
            { label: "Security model", slug: "security-model" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "cli" },
            { label: "C ABI", slug: "abi" },
            { label: "Architecture", slug: "architecture" },
          ],
        },
        ...(withApi ? [typeDocSidebarGroup] : []),
      ],
    }),
    react(),
    ...(withApi ? [typedocFixups({ output: "api" })] : []),
  ],
  markdown: {
    rehypePlugins: [rehypeLongCode],
  },
  vite: {
    // The workspace packages and this app each resolve React through pnpm; keep one copy in the bundle.
    resolve: { dedupe: ["react", "react-dom"] },
  },
});
