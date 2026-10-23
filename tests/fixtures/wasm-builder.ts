/**
 * Builds tiny, valid WebAssembly binaries for tests. Every exported function
 * takes no parameters and returns a constant i32; JavaScript callers may pass
 * extra arguments freely, so these stubs can stand in for any ABI export.
 */
export interface StubModuleOptions {
  /** Exported function name -> constant i32 return value. */
  exports: Record<string, number>;
  /** Linear memory limits in pages; null for no memory. */
  memory?: { min: number; max?: number; exported?: boolean; imported?: boolean } | null;
  imports?: { module: string; name: string }[];
}

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function sleb(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    const done = (n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

function str(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

function limits(min: number, max?: number): number[] {
  return max === undefined ? [0x00, ...uleb(min)] : [0x01, ...uleb(min), ...uleb(max)];
}

export function buildStubModule(options: StubModuleOptions): Uint8Array {
  const names = Object.keys(options.exports);
  const imports = options.imports ?? [];
  const memory = options.memory === undefined ? { min: 1, max: 16, exported: true } : options.memory;
  const bytes: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  // type section: one type () -> i32
  bytes.push(...section(1, [1, 0x60, 0, 1, 0x7f]));
  // import section
  const importEntries: number[] = [];
  let importCount = 0;
  if (memory && memory.imported) {
    importEntries.push(...str("env"), ...str("memory"), 0x02, ...limits(memory.min, memory.max));
    importCount++;
  }
  for (const imp of imports) {
    importEntries.push(...str(imp.module), ...str(imp.name), 0x00, 0);
    importCount++;
  }
  if (importCount > 0) bytes.push(...section(2, [...uleb(importCount), ...importEntries]));
  const importedFuncs = imports.length;
  // function section
  if (names.length > 0) bytes.push(...section(3, [...uleb(names.length), ...names.map(() => 0)]));
  // memory section
  if (memory && !memory.imported) bytes.push(...section(5, [1, ...limits(memory.min, memory.max)]));
  // export section
  const exportEntries: number[] = [];
  let exportCount = 0;
  names.forEach((name, i) => {
    exportEntries.push(...str(name), 0x00, ...uleb(importedFuncs + i));
    exportCount++;
  });
  if (memory && memory.exported !== false) {
    exportEntries.push(...str("memory"), 0x02, 0);
    exportCount++;
  }
  bytes.push(...section(7, [...uleb(exportCount), ...exportEntries]));
  // code section
  if (names.length > 0) {
    const bodies: number[] = [];
    for (const name of names) {
      const body = [0, 0x41, ...sleb(options.exports[name]!), 0x0b];
      bodies.push(...uleb(body.length), ...body);
    }
    bytes.push(...section(10, [...uleb(names.length), ...bodies]));
  }
  return new Uint8Array(bytes);
}

export const ABI_EXPORT_NAMES = [
  "audiospan_get_abi_version",
  "audiospan_alloc",
  "audiospan_free",
  "audiospan_create",
  "audiospan_destroy",
  "audiospan_reset",
  "audiospan_process",
  "audiospan_set_parameter",
  "audiospan_get_parameter",
  "audiospan_get_state_size",
  "audiospan_get_state",
  "audiospan_set_state",
] as const;

export const OPTIONAL_EXPORT_NAMES = ["audiospan_get_latency", "audiospan_get_output"] as const;

/**
 * A module exporting every required ABI function plus the optional
 * get_latency/get_output as stubs. alloc returns 1024, others return AS_OK
 * (their out-parameters stay 0, so latency and outputs read back as 0).
 */
export function buildAbiStubModule(
  overrides: Partial<Record<(typeof ABI_EXPORT_NAMES)[number] | (typeof OPTIONAL_EXPORT_NAMES)[number], number>> = {},
  memory?: StubModuleOptions["memory"],
  imports?: StubModuleOptions["imports"],
): Uint8Array {
  const exports: Record<string, number> = {};
  for (const name of ABI_EXPORT_NAMES) exports[name] = name === "audiospan_get_abi_version" ? 1 : name === "audiospan_alloc" ? 1024 : 0;
  for (const name of OPTIONAL_EXPORT_NAMES) exports[name] = 0;
  Object.assign(exports, overrides);
  return buildStubModule({ exports, memory, ...(imports ? { imports } : {}) });
}

// ---------------------------------------------------------------------------
// A small assembler for modules whose exports do real work (write to out
// pointers, call imports), used to exercise the optional ABI features.
// ---------------------------------------------------------------------------

export const I32 = 0x7f;
export const F64 = 0x7c;

export interface ModuleFunc {
  /** Export name; unexported when omitted. */
  name?: string;
  /** Index into `types`. */
  type: number;
  locals?: number[];
  /** Instructions without the trailing `end`. */
  body: number[];
}

export interface ModuleSpec {
  types: { params: number[]; results: number[] }[];
  imports?: { module: string; name: string; type: number }[];
  funcs: ModuleFunc[];
  globals?: { type: number; mutable: boolean; init: number }[];
  memory?: StubModuleOptions["memory"];
  data?: { offset: number; bytes: number[] }[];
}

export function buildModule(spec: ModuleSpec): Uint8Array {
  const memory = spec.memory === undefined ? { min: 1, max: 16, exported: true } : spec.memory;
  const bytes: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  bytes.push(...section(1, [...uleb(spec.types.length), ...spec.types.flatMap((t) => [0x60, ...uleb(t.params.length), ...t.params, ...uleb(t.results.length), ...t.results])]));
  const importEntries: number[] = [];
  let importCount = 0;
  if (memory && memory.imported) {
    importEntries.push(...str("env"), ...str("memory"), 0x02, ...limits(memory.min, memory.max));
    importCount++;
  }
  for (const imp of spec.imports ?? []) {
    importEntries.push(...str(imp.module), ...str(imp.name), 0x00, ...uleb(imp.type));
    importCount++;
  }
  if (importCount > 0) bytes.push(...section(2, [...uleb(importCount), ...importEntries]));
  const importedFuncs = (spec.imports ?? []).length;
  if (spec.funcs.length > 0) bytes.push(...section(3, [...uleb(spec.funcs.length), ...spec.funcs.flatMap((f) => uleb(f.type))]));
  if (memory && !memory.imported) bytes.push(...section(5, [1, ...limits(memory.min, memory.max)]));
  if (spec.globals && spec.globals.length > 0) {
    bytes.push(...section(6, [...uleb(spec.globals.length), ...spec.globals.flatMap((g) => [g.type, g.mutable ? 1 : 0, 0x41, ...sleb(g.init), 0x0b])]));
  }
  const exportEntries: number[] = [];
  let exportCount = 0;
  spec.funcs.forEach((f, i) => {
    if (f.name === undefined) return;
    exportEntries.push(...str(f.name), 0x00, ...uleb(importedFuncs + i));
    exportCount++;
  });
  if (memory && memory.exported !== false) {
    exportEntries.push(...str("memory"), 0x02, 0);
    exportCount++;
  }
  bytes.push(...section(7, [...uleb(exportCount), ...exportEntries]));
  if (spec.funcs.length > 0) {
    const bodies: number[] = [];
    for (const f of spec.funcs) {
      const locals = f.locals ?? [];
      const body = [...uleb(locals.length), ...locals.flatMap((t) => [1, t]), ...f.body, 0x0b];
      bodies.push(...uleb(body.length), ...body);
    }
    bytes.push(...section(10, [...uleb(spec.funcs.length), ...bodies]));
  }
  if (spec.data && spec.data.length > 0) {
    bytes.push(...section(11, [...uleb(spec.data.length), ...spec.data.flatMap((d) => [0, 0x41, ...sleb(d.offset), 0x0b, ...uleb(d.bytes.length), ...d.bytes])]));
  }
  return new Uint8Array(bytes);
}

function f64Bytes(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return Array.from(new Uint8Array(view.buffer));
}

export interface FeatureModuleOptions {
  /** Import `env.audiospan_log` and log "hello" (level 2) from every `audiospan_create`. */
  log?: boolean;
  /** Value every `audiospan_get_output` writes. */
  outputValue?: number;
}

/**
 * A module exercising the optional ABI features: `audiospan_create` writes
 * handle 1 (and optionally logs), `audiospan_get_latency` reports a global
 * that `audiospan_set_parameter` sets to the truncated parameter value (so
 * latency starts at 0 and follows whatever value is set), and
 * `audiospan_get_output` writes a constant. Every other export is a stub
 * returning AS_OK; alloc returns 1024.
 */
export function buildFeatureModule(options: FeatureModuleOptions = {}): Uint8Array {
  const T_VOID_I32 = 0; // () -> i32
  const T_II_I32 = 1; // (i32, i32) -> i32
  const T_III = 2; // (i32, i32, i32) -> ()
  const T_IIF_I32 = 3; // (i32, i32, f64) -> i32
  const T_III_I32 = 4; // (i32, i32, i32) -> i32
  const ok = [0x41, 0x00];
  const stub = (name: string): ModuleFunc => ({ name, type: T_VOID_I32, body: ok });
  const LOCAL_GET = 0x20;
  const GLOBAL_GET = 0x23;
  const GLOBAL_SET = 0x24;
  const I32_CONST = 0x41;
  const F64_CONST = 0x44;
  const I32_STORE = [0x36, 0x02, 0x00];
  const F64_STORE = [0x39, 0x03, 0x00];
  const CALL = 0x10;
  const I32_TRUNC_F64_S = 0xaa;
  const hello = Array.from(new TextEncoder().encode("hello"));
  return buildModule({
    types: [
      { params: [], results: [I32] },
      { params: [I32, I32], results: [I32] },
      { params: [I32, I32, I32], results: [] },
      { params: [I32, I32, F64], results: [I32] },
      { params: [I32, I32, I32], results: [I32] },
    ],
    imports: options.log ? [{ module: "env", name: "audiospan_log", type: T_III }] : [],
    globals: [{ type: I32, mutable: true, init: 0 }],
    data: options.log ? [{ offset: 0, bytes: hello }] : [],
    funcs: [
      { name: "audiospan_get_abi_version", type: T_VOID_I32, body: [I32_CONST, 0x01] },
      { name: "audiospan_alloc", type: T_VOID_I32, body: [I32_CONST, ...sleb(1024)] },
      stub("audiospan_free"),
      {
        name: "audiospan_create",
        type: T_II_I32,
        body: [
          LOCAL_GET, 0x01, I32_CONST, 0x01, ...I32_STORE, // *out_instance = 1
          ...(options.log ? [I32_CONST, 0x02, I32_CONST, 0x00, I32_CONST, 0x05, CALL, 0x00] : []), // audiospan_log(2, "hello", 5)
          ...ok,
        ],
      },
      stub("audiospan_destroy"),
      stub("audiospan_reset"),
      stub("audiospan_process"),
      { name: "audiospan_set_parameter", type: T_IIF_I32, body: [LOCAL_GET, 0x02, I32_TRUNC_F64_S, GLOBAL_SET, 0x00, ...ok] }, // latency = trunc(value)
      stub("audiospan_get_parameter"),
      stub("audiospan_get_state_size"),
      stub("audiospan_get_state"),
      stub("audiospan_set_state"),
      { name: "audiospan_get_latency", type: T_II_I32, body: [LOCAL_GET, 0x01, GLOBAL_GET, 0x00, ...I32_STORE, ...ok] },
      { name: "audiospan_get_output", type: T_III_I32, body: [LOCAL_GET, 0x02, F64_CONST, ...f64Bytes(options.outputValue ?? 0.5), ...F64_STORE, ...ok] },
    ],
  });
}
