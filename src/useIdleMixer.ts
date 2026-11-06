import { useCallback, useEffect, useState } from "react";
import { tauriEmit, tauriListen } from "./vendor/tauri-events";
import {
  loadIdleMixer,
  saveIdleMixer,
  type IdleMixerConfig,
} from "./engine/idle/idle-mixer";

const LOCAL_EVENT = "idle-mixer-local";

export function useIdleMixer() {
  const [cfg, setCfg] = useState<IdleMixerConfig>(loadIdleMixer);

  useEffect(() => {
    const onLocal = () => setCfg(loadIdleMixer());
    window.addEventListener(LOCAL_EVENT, onLocal);
    // Host-global broadcast so the main window's live mixer reloads; the
    // plugin-namespaced ctx.events would never reach it.
    let unlisten: (() => void) | null = null;
    void tauriListen("idle-mixer-changed", onLocal)
      .then((off) => {
        unlisten = off;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
      window.removeEventListener(LOCAL_EVENT, onLocal);
    };
  }, []);

  const update = useCallback((next: IdleMixerConfig) => {
    setCfg(next);
    saveIdleMixer(next);
    window.dispatchEvent(new Event(LOCAL_EVENT));
    void tauriEmit("idle-mixer-changed").catch(() => {});
  }, []);

  return [cfg, update] as const;
}
