// Display settings (Settings → Model → Display): stage scale, screen-space
// offsets, and cursor tracking. Mirrors the l2d plugin's DisplaySection so
// both avatars configure alike — persistence via plugin storage, live updates
// through the plugin-namespaced display-changed event that the main-window
// engine answers.

import { useEffect, useState, type ChangeEvent } from "react";
import type { PluginContext } from "@companion-lab/plugin";
import { coerceDisplay, type DisplaySettings } from "./engine/display";

const DISPLAY_STORAGE_KEY = "display";

export function DisplaySection({ ctx }: { ctx: PluginContext }) {
  const { SectionCard, RangeSlider, FormField } = ctx.ui;
  const [display, setDisplay] = useState<DisplaySettings | null>(null);

  useEffect(() => {
    void ctx.storage
      .get<DisplaySettings>(DISPLAY_STORAGE_KEY)
      .then((stored) => setDisplay(coerceDisplay(stored)))
      .catch(() => setDisplay(coerceDisplay(null)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!display) {
    return (
      <SectionCard title="Display" badge="…">
        <p style={{ margin: 0, opacity: 0.6 }}>Loading…</p>
      </SectionCard>
    );
  }

  const update = (patch: Partial<DisplaySettings>) => {
    setDisplay((prev) => {
      const next = coerceDisplay({ ...(prev ?? {}), ...patch });
      void ctx.storage.set(DISPLAY_STORAGE_KEY, next).catch(() => undefined);
      ctx.events.emit("display-changed", next);
      return next;
    });
  };

  return (
    <SectionCard title="Display" badge="saved">
      <RangeSlider
        label="Scale"
        valueLabel={`${display.scale.toFixed(2)}×`}
        min={0.4}
        max={2.5}
        step={0.05}
        value={display.scale}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          update({ scale: parseFloat(e.target.value) })
        }
      />
      <RangeSlider
        label="Horizontal offset"
        valueLabel={`${Math.round(display.x)} px`}
        min={-160}
        max={160}
        step={2}
        value={display.x}
        onChange={(e: ChangeEvent<HTMLInputElement>) => update({ x: parseFloat(e.target.value) })}
      />
      <RangeSlider
        label="Vertical offset"
        valueLabel={`${Math.round(display.y)} px`}
        min={-220}
        max={160}
        step={2}
        value={display.y}
        onChange={(e: ChangeEvent<HTMLInputElement>) => update({ y: parseFloat(e.target.value) })}
      />
      <FormField label="Cursor tracking" hint="The character's head and eyes follow your cursor.">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={display.tracking}
            onChange={(e) => update({ tracking: e.target.checked })}
            style={{ width: 16, height: 16, accentColor: "var(--accent, #7c6cf6)" }}
          />
          Follow the cursor
        </label>
      </FormField>
    </SectionCard>
  );
}
