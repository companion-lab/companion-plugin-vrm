// Idle-motions settings section — moved from the host
// (app/src/ui/organisms/IdleMixerSection.tsx) now that the idle mixer engine
// lives in this plugin. Registered under the section id "motion.idleMixer",
// the same id the host's builtin.tsx used, so the override contract holds.

import type { ChangeEvent } from "react";
import type { PluginContext } from "@companion-lab/plugin";
import { useIdleMixer } from "./useIdleMixer";

export function IdleMixerSection({ ctx }: { ctx: PluginContext }) {
  const { SectionCard, FormField, Button, RangeSlider } = ctx.ui;
  const [cfg, apply] = useIdleMixer();

  const badge = !cfg.enabled ? "off" : `${cfg.idleMotions.length} selected • every ${cfg.minSec}–${cfg.maxSec}s`;

  return (
    <SectionCard title="Idle Motions" badge={badge}>
      <FormField
        label="Random idle playback"
        hint="When silent, plays a random ticked motion every Min–Max seconds. Pauses during speech and chat motions."
      >
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant={cfg.enabled ? "primary" : "secondary"} onClick={() => apply({ ...cfg, enabled: true })}>
            On
          </Button>
          <Button variant={!cfg.enabled ? "primary" : "secondary"} onClick={() => apply({ ...cfg, enabled: false })}>
            Off
          </Button>
        </div>
      </FormField>
      <FormField label={`Min gap: ${cfg.minSec}s`}>
        <RangeSlider
          min={3}
          max={300}
          step={1}
          value={cfg.minSec}
          disabled={!cfg.enabled}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const v = Number(e.target.value);
            apply({ ...cfg, minSec: Math.min(v, cfg.maxSec) });
          }}
        />
      </FormField>
      <FormField label={`Max gap: ${cfg.maxSec}s`}>
        <RangeSlider
          min={3}
          max={300}
          step={1}
          value={cfg.maxSec}
          disabled={!cfg.enabled}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const v = Number(e.target.value);
            apply({ ...cfg, maxSec: Math.max(v, cfg.minSec) });
          }}
        />
      </FormField>
    </SectionCard>
  );
}
