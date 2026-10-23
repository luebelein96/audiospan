import { AudiospanHost, AudiospanError } from "/__audiospan/sdk.js";
import { renderPluginPanel } from "/__audiospan/ui.js";

const params = new URLSearchParams(location.search);
const pluginUrl = params.get("plugin") ?? "/dist/plugin.json";
const $ = (id) => document.getElementById(id);
$("plugin-url").textContent = pluginUrl;

const state = { context: null, host: null, plugin: null, chain: null, panel: null, source: null, sourceGain: null, saved: null, mtime: 0, poll: null };
const logLines = [];

function log(line) {
  logLines.push(`${new Date().toLocaleTimeString()} ${line}`);
  while (logLines.length > 200) logLines.shift();
  $("log").textContent = logLines.join("\n");
  $("log").scrollTop = $("log").scrollHeight;
}

function setStatus(text, kind = "info") {
  $("status").textContent = text;
  $("status").dataset.kind = kind;
}

function setButtons(running) {
  $("start").disabled = running;
  for (const id of ["stop", "save", "restore", "reload"]) $(id).disabled = !running;
  $("restore").disabled = !running || !state.saved;
}

async function createSource(kind) {
  const ctx = state.context;
  if (kind === "mic") {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return ctx.createMediaStreamSource(stream);
  }
  if (kind === "noise") {
    const seconds = 2;
    const buffer = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.start();
    return node;
  }
  const osc = ctx.createOscillator();
  osc.type = kind === "saw" ? "sawtooth" : "sine";
  osc.frequency.value = kind === "saw" ? 110 : 220;
  osc.start();
  return osc;
}

async function switchSource() {
  if (!state.host) return;
  if (state.source) {
    try { state.source.disconnect(); } catch {}
    if (state.source.stop) { try { state.source.stop(); } catch {} }
  }
  state.source = await createSource($("source").value);
  state.source.connect(state.sourceGain);
  updateSourceLevel();
}

function updateSourceLevel() {
  if (!state.sourceGain) return;
  state.sourceGain.gain.value = $("source-on").checked ? Number($("level").value) : 0;
}

async function loadPlugin(restoreState) {
  const host = state.host;
  if (state.panel) { state.panel.destroy(); state.panel = null; }
  if (state.plugin) { await state.plugin.dispose(); state.plugin = null; }
  if (state.chain) { await state.chain.dispose(); state.chain = null; }
  for (const d of host.listPlugins()) await host.unloadPlugin(d.id).catch(() => {});
  const descriptor = await host.loadPlugin(pluginUrl);
  log(`loaded ${descriptor.id}@${descriptor.version} (${descriptor.moduleByteLength} bytes, ${descriptor.parameters.length} parameters)`);
  for (const w of descriptor.warnings) log(`warning: ${w.code} ${w.path}: ${w.message}`);
  const plugin = await host.createPlugin(descriptor.id, restoreState && restoreState.pluginId === descriptor.id ? { initialState: restoreState } : {});
  const chain = host.createChain();
  chain.add(plugin);
  await host.connectChain(chain);
  state.plugin = plugin;
  state.chain = chain;
  state.panel = renderPluginPanel($("panel"), plugin);
  plugin.on("error", (e) => log(`plugin error: ${e.error.code}: ${e.error.message}`));
  setStatus(`Running ${descriptor.name} at ${state.context.sampleRate} Hz`);
}

async function currentMtime() {
  try {
    const wasmPath = new URL(pluginUrl, location.href).pathname.replace(/plugin\.json$/, "module.wasm");
    const res = await fetch(`/__audiospan/mtime?file=${encodeURIComponent(wasmPath)}`, { cache: "no-store" });
    return (await res.json()).mtime;
  } catch {
    return 0;
  }
}

async function start() {
  try {
    setStatus("Starting…");
    const ctx = new AudioContext();
    await ctx.resume();
    state.context = ctx;
    const host = await AudiospanHost.create({
      audioContext: ctx,
      diagnostics: $("diag").checked,
      pluginLogging: true, // accept `audiospan build --dev` modules and show their log lines below
      pluginPolicy: { allowRemotePlugins: false },
      onError: (error) => log(`host error: ${error.code}: ${error.message}`),
      onDiagnostic: (event) => {
        if (event.kind === "processing-stats") log(`stats: median ${event.medianMs.toFixed(3)} ms, p95 ${event.p95Ms.toFixed(3)} ms, budget ${event.budgetMs.toFixed(3)} ms, plugins ${event.activePlugins}`);
        else if (event.kind !== "parameter-update") log(`diag: ${JSON.stringify(event)}`);
      },
    });
    state.host = host;
    host.on("pluginlog", (e) => log(`plugin ${e.level}: ${e.message}${e.dropped ? ` (+${e.dropped} dropped)` : ""}`));
    state.sourceGain = ctx.createGain();
    host.connectSource(state.sourceGain);
    host.connectDestination(ctx.destination);
    await switchSource();
    await loadPlugin(null);
    state.mtime = await currentMtime();
    state.poll = setInterval(async () => {
      const m = await currentMtime();
      if (m && state.mtime && m !== state.mtime) {
        state.mtime = m;
        log("artifact changed; reloading plugin");
        await reload();
      } else if (m && !state.mtime) {
        state.mtime = m;
      }
    }, 2000);
    setButtons(true);
  } catch (error) {
    const message = error instanceof AudiospanError ? `${error.code}: ${error.message}` : String(error);
    setStatus(`Failed: ${message}`, "error");
    log(message);
    await stop();
  }
}

async function reload() {
  if (!state.host) return;
  try {
    const saved = state.plugin ? await state.plugin.getState().catch(() => null) : null;
    await loadPlugin(saved);
    log("plugin reloaded");
  } catch (error) {
    const message = error instanceof AudiospanError ? `${error.code}: ${error.message}` : String(error);
    setStatus(`Reload failed: ${message}`, "error");
    log(message);
  }
}

async function stop() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
  if (state.panel) { state.panel.destroy(); state.panel = null; }
  if (state.host) { await state.host.dispose().catch(() => {}); state.host = null; }
  if (state.source && state.source.stop) { try { state.source.stop(); } catch {} }
  state.source = null;
  state.plugin = null;
  state.chain = null;
  if (state.context) { await state.context.close().catch(() => {}); state.context = null; }
  setButtons(false);
  setStatus("Stopped.");
}

$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);
$("source").addEventListener("change", () => switchSource().catch((e) => log(String(e))));
$("source-on").addEventListener("change", updateSourceLevel);
$("level").addEventListener("input", updateSourceLevel);
$("reload").addEventListener("click", reload);
$("save").addEventListener("click", async () => {
  if (!state.plugin) return;
  state.saved = await state.plugin.getState();
  localStorage.setItem("audiospan-sandbox-state", JSON.stringify(state.saved));
  $("restore").disabled = false;
  log(`saved state: ${JSON.stringify(state.saved.parameters)}`);
});
$("restore").addEventListener("click", async () => {
  if (!state.plugin || !state.saved) return;
  try {
    await state.plugin.setState(state.saved);
    log("state restored");
  } catch (error) {
    log(`restore failed: ${error.message}`);
  }
});
try {
  const stored = localStorage.getItem("audiospan-sandbox-state");
  if (stored) state.saved = JSON.parse(stored);
} catch {}
