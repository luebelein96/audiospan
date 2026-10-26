// starlight-typedoc deletes the per-package `README.md` entry pages in packages mode and
// rewrites links to TypeDoc pages as `<path>/<file>/`. We generate the entry pages as
// `index.md` instead (TypeDoc `entryFileName`), which Starlight serves at `<path>/`, so
// the generated links must lose their trailing `index/` segment. Runs in `astro:config:done`,
// after every integration's `astro:config:setup` (where the pages are generated).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export default function typedocFixups({ output = "api" } = {}) {
  return {
    name: "audiospan:typedoc-fixups",
    hooks: {
      "astro:config:done": ({ config, logger }) => {
        const root = fileURLToPath(new URL(`content/docs/${output}/`, config.srcDir));
        if (!existsSync(root)) return;
        let files = 0;
        let links = 0;
        const walk = (dir) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith(".md")) {
              const text = readFileSync(path, "utf8");
              const next = text.replace(/\]\(([^)\s]*?)\/index\/(#[^)]*)?\)/g, (_, before, anchor = "") => {
                links++;
                return `](${before}/${anchor})`;
              });
              if (next !== text) {
                writeFileSync(path, next);
                files++;
              }
            }
          }
        };
        walk(root);
        logger.info(`rewrote ${links} entry-page links in ${files} files`);
      },
    },
  };
}
