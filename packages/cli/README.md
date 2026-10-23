# @audiospan/cli

```sh
npm install -g @audiospan/cli
audiospan create my-filter --language cpp   # or rust; --template gain for the smallest plugin
cd my-filter
audiospan build && audiospan test && audiospan dev --watch
audiospan validate dist && audiospan pack
```

Commands: `create`, `build`, `generate`, `test` (`--update` records expectations), `validate`, `pack`, `dev` (`--watch`), `doctor`. `build` regenerates `generated/audiospan_params.{h,rs}` and `dist/plugin.d.ts` from `plugin.json`. Docs: [CLI reference](../../docs/cli.md).
