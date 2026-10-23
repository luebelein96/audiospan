// Vanilla JavaScript integration. Everything the host needs is two files
// copied next to this page by build.mjs: the SDK bundle (which embeds the
// worklet) and the UI bundle. The plugin artifact lives under ./plugins/gain/.
import { AudiospanHost, AudiospanError } from "./vendor/audiospan-sdk.bundle.js";
import { renderPluginPanel } from "./vendor/audiospan-ui.bundle.js";

const $ = (id) => document.getElementById(id);
let context = null;
let host = null;
let plugin = null;
let panel = null;
let oscillator = null;
let savedState = null;

function log(text) {
  $("log").textContent += `${text}\n`;
}

function status(text, kind = "info") {
  $("status").textContent = text;
  $("status").dataset.kind = kind;
}

async function start() {
  $("start").disabled = true;
  try {
    // 1. Create (or resume) the AudioContext from the click handler.
    context = new AudioContext();
    await context.resume();

    // 2. Create the host. Without a workletUrl the SDK loads its embedded worklet.
    host = await AudiospanHost.create({
      audioContext: context,
      maxPlugins: 4,
      onError: (error) => log(`error ${error.code}: ${error.message}`),
    });

    // 3. Load the plugin, create an instance, and put it in the chain: one call.
    plugin = await host.addPlugin(new URL("./plugins/gain/plugin.json", import.meta.url).href, savedState ? { initialState: savedState } : {});
    const descriptor = plugin.descriptor;

    // 4. Wire up the audio graph.
    oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const level = context.createGain();
    level.gain.value = 0.2;
    oscillator.connect(level);
    oscillator.start();
    host.connectSource(level);
    host.connectDestination(context.destination);

    // 5. Default controls generated from the manifest.
    panel = renderPluginPanel($("panel"), plugin);
    plugin.on("parameterchange", (e) => log(`${e.parameterId} = ${e.value}`));

    status(`Running ${descriptor.name} ${descriptor.version} at ${context.sampleRate} Hz`);
    for (const id of ["stop", "save"]) $(id).disabled = false;
    $("restore").disabled = !savedState;
  } catch (error) {
    const message = error instanceof AudiospanError ? `${error.code}: ${error.message}` : String(error);
    status(`Failed to start: ${message}`, "error");
    await stop();
  }
}

async function stop() {
  panel?.destroy();
  panel = null;
  if (oscillator) {
    try { oscillator.stop(); } catch {}
    oscillator = null;
  }
  if (host) await host.dispose();
  host = null;
  plugin = null;
  if (context) await context.close().catch(() => {});
  context = null;
  $("start").disabled = false;
  for (const id of ["stop", "save", "restore"]) $(id).disabled = true;
  status("Stopped.");
}

$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);
$("save").addEventListener("click", async () => {
  savedState = await plugin.getState();
  $("restore").disabled = false;
  log(`saved ${JSON.stringify(savedState.parameters)}`);
});
$("restore").addEventListener("click", async () => {
  await plugin.setState(savedState);
  log("restored");
});
