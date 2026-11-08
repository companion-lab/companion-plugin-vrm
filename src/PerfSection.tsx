// Graphics settings — the former core Performance tab, now owned by the vrm
// plugin: its backend persists the config file and broadcasts perf-changed
// (plugin-namespaced) on set. The section reads/writes the shared settings-
// page state through the SDK's useSettingsState bridge; the SettingsPage
// persists via the plugin backend (see app/src/perf.ts).
// The former "Model Loading" card (load mode, TTS threads, idle unload) moved
// to the voice plugins whose engines it configures: the tts plugin renders
// load mode + TTS threads in its Speech Synthesis section, the stt plugin the
// idle unload in its Speech Recognition section.

import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import { useSettingsState } from "../../../sdk/js/@companion/plugin";

type PerfConfig = {
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

const RATIO_OPTIONS = [1.0, 1.25, 1.5, 2.0] as const;

export function GraphicsSection({ ctx }: { ctx: PluginContext }) {
  const { SectionCard, FormField } = ctx.ui;
  const { perf, setPerf } = useSettingsState();
  const onChange = (next: PerfConfig) => setPerf(next);

  return (
    <>
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
