import { Knob, useAudioSource, useAudiospanHost, useOutput, useParameter, usePlugin, type TypedPluginInstance } from "@audiospan/react";
import { useEffect, useRef, useState } from "react";
import "./demo.css";

/**
 * The reference gain plugin that ships with this site. An application imports
 * the `plugin.d.ts` that `audiospan build` writes next to the artifact instead
 * of spelling the ids out.
 */
type GainPlugin = TypedPluginInstance<"gain", "level", "default" | "half" | "boost">;
type PresetId = "default" | "half" | "boost";

// scripts/copy-plugin.mjs puts plugins/gain-cpp/dist under public/plugins/gain.
const PLUGIN_URL = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/plugins/gain/plugin.json`;

// Shown until the manifest arrives, so the panel does not reflow.
const FALLBACK_PRESETS = [
  { id: "default", name: "Default" },
  { id: "half", name: "Half" },
  { id: "boost", name: "Boost" },
];

type SourceKind = "tone" | "microphone";

/** A quiet sawtooth, so the gain and the meter have something to work on. */
function tone(context: BaseAudioContext): AudioNode {
  const oscillator = context.createOscillator();
  oscillator.type = "sawtooth";
  oscillator.frequency.value = 110;
  const level = context.createGain();
  level.gain.value = 0.25;
  oscillator.connect(level);
  oscillator.start();
  return level;
}

const SEGMENTS = 24;

/** A segmented level meter with a slowly falling peak mark. */
function LevelMeter({ value, min, max, active }: { value: number; min: number; max: number; active: boolean }) {
  const normalized = active ? Math.min(1, Math.max(0, (value - min) / (max - min || 1))) : 0;
  const peakRef = useRef({ value: 0, at: 0 });
  const [peak, setPeak] = useState(0);
  useEffect(() => {
    const now = performance.now();
    const p = peakRef.current;
    if (normalized >= p.value) {
      p.value = normalized;
      p.at = now;
    } else if (now - p.at > 600) {
      p.value = Math.max(normalized, p.value - 0.04);
    }
    setPeak(p.value);
  }, [normalized]);
  const lit = Math.round(normalized * SEGMENTS);
  const peakIndex = Math.round(peak * SEGMENTS) - 1;
  return (
    <div className="as-demo__segments" role="meter" aria-label="Output level" aria-valuemin={min} aria-valuemax={max} aria-valuenow={active ? value : undefined}>
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span key={i} className="as-demo__segment" data-zone={i >= SEGMENTS * 0.85 ? "hot" : i >= SEGMENTS * 0.5 ? "warm" : "cool"} data-lit={i < lit || i === peakIndex} />
      ))}
    </div>
  );
}

export default function LiveDemo() {
  const [sourceKind, setSourceKind] = useState<SourceKind>("tone");
  // Owns the AudioContext and the host; start() runs from the click below. No workletUrl: the SDK embeds the worklet.
  const audio = useAudiospanHost();
  // Loads the plugin, creates an instance and puts it in the chain once the host runs. Ids are typed.
  const gain = usePlugin<GainPlugin>(audio.host, PLUGIN_URL);
  // Feeds the chain. Changing the kind disconnects the old source and connects the new one.
  const source = useAudioSource(audio, sourceKind === "microphone" ? "microphone" : tone);
  const gainParam = useParameter(gain, "gain");
  const level = useOutput(gain, "level");

  const running = audio.status === "running";
  const ready = gain.status === "ready";
  const error = audio.error ?? gain.error ?? source.error;
  const name = gain.descriptor?.name ?? "Gain (C++)";

  let status: string;
  if (audio.status === "starting") status = "Starting the audio context…";
  else if (running && gain.status === "error") status = "The plugin failed to load.";
  else if (running && !ready) status = "Loading the plugin…";
  else if (running && gain.descriptor) {
    const sourceLabel = sourceKind === "microphone" ? (source.status === "connected" ? "microphone" : "connecting the microphone…") : "test tone";
    status = `${name} ${gain.descriptor.version} · ${audio.audioContext?.sampleRate ?? 0} Hz · ${sourceLabel}`;
  } else if (audio.status === "error") status = "Could not start.";
  else status = "Press Start to create the audio context and load the plugin.";

  const meterMin = level.model?.min ?? 0;
  const meterMax = level.model?.max ?? 1;
  const fmt = (v: number) => (level.model ? level.format(v) : v.toFixed(1));

  return (
    <section className="as-demo not-content" data-status={audio.status} aria-label="Live demo: the reference gain plugin">
      <header className="as-demo__head">
        <div className="as-demo__name">
          <span className="as-demo__led" aria-hidden="true" />
          <span className="as-demo__title">{name}</span>
          <span className="as-demo__chip">C++ → WebAssembly</span>
          <span className="as-demo__chip">AudioWorklet</span>
        </div>
        <button type="button" className="as-demo__bypass" aria-pressed={gain.bypassed} disabled={!ready} onClick={() => gain.setBypassed(!gain.bypassed)}>
          Bypass
        </button>
      </header>

      <div className="as-demo__transport">
        {running ? (
          <button type="button" className="as-demo__power as-demo__power--on" onClick={() => void audio.stop()}>
            <span className="as-demo__glyph" aria-hidden="true">
              ■
            </span>
            Stop
          </button>
        ) : (
          <button type="button" className="as-demo__power" onClick={() => void audio.start()} disabled={audio.status === "starting"}>
            <span className="as-demo__glyph" aria-hidden="true">
              ▶
            </span>
            Start audio
          </button>
        )}
        <label className="as-demo__source">
          <span>Source</span>
          <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as SourceKind)}>
            <option value="tone">Test tone</option>
            <option value="microphone">Microphone</option>
          </select>
        </label>
      </div>

      <div className="as-demo__controls">
        <div className="as-demo__knob">
          <Knob plugin={gain} id="gain" size={96} />
          <span className="as-demo__value">{ready ? gainParam.format(gainParam.value) : "—"}</span>
          <span className="as-demo__label">{gainParam.model?.label ?? "Gain"}</span>
        </div>
        <div className="as-demo__meter">
          <div className="as-demo__meter-head">
            <span className="as-demo__label">{level.model?.label ?? "Output level"}</span>
            <span className="as-demo__value as-demo__value--small">{ready && running ? level.format(level.value) : "—"}</span>
          </div>
          <LevelMeter value={level.value} min={meterMin} max={meterMax} active={ready && running && !gain.bypassed} />
          <div className="as-demo__scale" aria-hidden="true">
            <span>{fmt(meterMin)}</span>
            <span>{fmt((meterMin + meterMax) / 2)}</span>
            <span>{fmt(meterMax)}</span>
          </div>
        </div>
      </div>

      <footer className="as-demo__foot">
        <div className="as-demo__presets" role="group" aria-label="Presets">
          <span className="as-demo__label">Presets</span>
          {(gain.descriptor?.presets ?? FALLBACK_PRESETS).map((preset) => (
            <button key={preset.id} type="button" className="as-demo__preset" disabled={!ready} onClick={() => void gain.loadPreset(preset.id as PresetId)}>
              {preset.name}
            </button>
          ))}
        </div>
        <p className="as-demo__status" role="status">
          {status}
        </p>
        {error && (
          <p className="as-demo__error">
            {"code" in error ? `${error.code}: ` : ""}
            {error.message}
          </p>
        )}
      </footer>
    </section>
  );
}
