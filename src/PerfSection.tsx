// Graphics + model-loading settings — the former core Performance tab, now
// owned by the vrm plugin. The host SettingsPage still owns perf load/save/
// persist (the backend owns the config file and the perf-changed broadcast);
// the section reads/writes that shared state through the SDK's
// useSettingsState bridge. The old "release model memory" card was dropped:
// the voice plugin owns the TTS/STT engines and their memory now.

import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import { useSettingsState } from "../../../sdk/js/@companion/plugin";

type PerfConfig = {
  load_mode: "eager" | "lazy";
  tts_threads: number;
  unload_stt_when_idle: boolean;
  max_pixel_ratio: number;
  fps_cap: "thirty" | "sixty" | "uncapped";
  antialias: boolean;
};

function Presets<T extends string | number>({
  options,
  active,
  onPick,
  format,
}: {
  options: readonly T[];
  active: T;
  onPick: (v: T) => void;
  format?: (v: T) => string;
}) {
  return (
    <div className="preset-bar">
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          onClick={() => onPick(o)}
          className={`preset-btn ${o === active ? "preset-btn-active" : ""}`}
        >
          {format ? format(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

const THREAD_OPTIONS = [0, 2, 4, 8] as const;
const RATIO_OPTIONS = [1.0, 1.25, 1.5, 2.0] as const;

export function GraphicsSection({ ctx }: { ctx: PluginContext }) {
  const { SectionCard, FormField } = ctx.ui;
  const { perf, setPerf } = useSettingsState();
  const onChange = (next: PerfConfig) => setPerf(next);

  return (
    <>
      <SectionCard title="Model Loading">
        <FormField
          label="Load mode"
          hint="Lazy keeps the ~650 MB of TTS/STT models unloaded until first use: low idle RAM, slower first reply. Applies on next launch."
        >
          <Presets
            options={["lazy", "eager"] as const}
            active={perf.load_mode}
            onPick={(v) => onChange({ ...perf, load_mode: v })}
            format={(v) => (v === "lazy" ? "Lazy" : "Eager")}
          />
        </FormField>

        <FormField
          label="TTS inference threads"
          hint="CPU threads per TTS session. Auto follows core count. Lower this if synthesis starves the avatar render loop."
        >
          <Presets
            options={THREAD_OPTIONS}
            active={perf.tts_threads}
            onPick={(v) => onChange({ ...perf, tts_threads: v })}
            format={(v) => (v === 0 ? "Auto" : v === 8 ? "Max" : String(v))}
          />
        </FormField>

        <FormField
          label="Unload mic model when idle"
          hint="Drop the speech model from RAM after the mic stops. Next mic tap reloads it (a few seconds)."
        >
          <Presets
            options={["on", "off"] as const}
            active={perf.unload_stt_when_idle ? "on" : "off"}
            onPick={(v) => onChange({ ...perf, unload_stt_when_idle: v === "on" })}
            format={(v) => (v === "on" ? "On" : "Off")}
          />
        </FormField>
      </SectionCard>

      <SectionCard
        title="Graphics"
        badge={`${perf.max_pixel_ratio.toFixed(2)}× • ${
          perf.fps_cap === "uncapped" ? "uncapped" : `${perf.fps_cap === "thirty" ? 30 : 60} fps`
        }`}
      >
        <FormField
          label="Render resolution cap"
          hint="Caps device-pixel scaling. 1.5× keeps the avatar sharp at a fraction of the 2×/3× fragment cost."
        >
          <Presets
            options={RATIO_OPTIONS}
            active={perf.max_pixel_ratio}
            onPick={(v) => onChange({ ...perf, max_pixel_ratio: v })}
            format={(v) => `${v.toFixed(2)}×`}
          />
        </FormField>

        <FormField
          label="Frame rate cap"
          hint="Idle motion is slow breathing and blinking; 30 fps looks identical and halves render work."
        >
          <Presets
            options={["thirty", "sixty", "uncapped"] as const}
            active={perf.fps_cap}
            onPick={(v) => onChange({ ...perf, fps_cap: v })}
            format={(v) => (v === "thirty" ? "30 fps" : v === "sixty" ? "60 fps" : "Uncapped")}
          />
        </FormField>

        <FormField
          label="Antialiasing"
          hint="MSAA smooths hair and edges but costs fill rate on the transparent window. Requires restart."
        >
          <Presets
            options={["on", "off"] as const}
            active={perf.antialias ? "on" : "off"}
            onPick={(v) => onChange({ ...perf, antialias: v === "on" })}
            format={(v) => (v === "on" ? "On" : "Off")}
          />
        </FormField>
      </SectionCard>
    </>
  );
}
