# @audiospan/manifest

Types, JSON schema, and validation for Audiospan `plugin.json` manifests, plus parameter math (`clampParameterValue`, `toNormalized`, `fromNormalized`, `formatParameterValue`) and state/preset validation. Pure functions; runs anywhere.

```ts
import { parseManifest } from "@audiospan/manifest";
const result = parseManifest(text);
if (result.ok) console.log(result.manifest.parameters);
else console.error(result.errors);
```

Docs: [manifest schema](../../docs/manifest-schema.md).
