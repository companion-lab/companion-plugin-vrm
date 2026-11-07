// Emotions settings section — port of the host organism
// app/src/ui/organisms/EmotionsSection.tsx. Tauri invoke/emit become the
// plugin backend api and namespaced ctx.events; built-in emotion metadata is
// inlined from app/src/expression/registry.ts.

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import {
  makeLibraryApi,
  useVrmaImport,
  type EmotionMeta,
} from "./backend";
import { callWithRetry } from "./retry";

// From app/src/expression/registry.ts — the presets three-vrm ships.
const BUILTIN_EMOTION_META: Array<{ name: string; preset: string }> = [
  { name: "neutral", preset: "neutral" },
  { name: "happy", preset: "happy" },
  { name: "sad", preset: "sad" },
  { name: "angry", preset: "angry" },
  { name: "surprised", preset: "surprised" },
  { name: "relaxed", preset: "relaxed" },
];

function EmotionRow({ ui, e, builtin, onTest, onDelete }: {
  ui: PluginContext["ui"];
  e: EmotionMeta;
  builtin?: boolean;
  onTest: (name: string) => void;
  onDelete?: (name: string) => void;
}) {
  const { Button } = ui;
  return (
    <div className="item-row" style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="item-title">{e.name}</div>
          <div className="item-meta">→ {e.preset}{builtin ? " • built-in" : ""}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <Button variant="primary" onClick={() => onTest(e.name)} style={{ padding: "5px 10px", fontSize: 11 }}>
            Test
          </Button>
          {!builtin && (
            <Button variant="danger" onClick={() => onDelete?.(e.name)} style={{ padding: "5px 10px", fontSize: 11 }}>
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmotionsSection({ ctx }: { ctx: PluginContext }) {
  const { ui } = ctx;
  const { SectionCard, ConfirmModal } = ui;
  const api = makeLibraryApi(ctx);
  const { importFile, vrmaFiles } = useVrmaImport(ctx);
  const [emotions, setEmotions] = useState<EmotionMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      // Retry wraps the read: backend invokes issued right after a plugin
      // (re)enable occasionally never resolve on macOS (see retry.ts).
      const list = await callWithRetry(
        () => api.listEmotions(),
        ctx.log,
        "vrm.list_emotions",
      );
      setEmotions(list);
    } catch (err) {
      console.error("vrm.list_emotions failed", err);
    }
  };

  useEffect(() => {
    refresh();
    // Motions and emotions live together (.vrma imports create both), so the
    // motions section's saves/deletes refresh this list too.
    return ctx.events.on("motion-library-changed", () => { refresh(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteEmotion(pendingDelete);
      ctx.events.emit("motion-library-changed");
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const handleTest = (name: string) => {
    ctx.events.emit("expression-test", name);
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = vrmaFiles(e.target.files);
    if (!files.length) return;
    setImporting(true);
    setImportProgress(null);
    setError(null);
    try {
      const failures: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setImportProgress(`Importing ${i + 1}/${files.length}: ${files[i].name}`);
        try {
          await importFile(files[i]);
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
      if (failures.length) setError(failures.join("\n"));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
      setImportProgress(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const all: Array<EmotionMeta & { builtin?: boolean }> = [
    ...BUILTIN_EMOTION_META.map((b) => ({
      name: b.name,
      preset: b.preset,
      reset_ms: 4000,
      builtin: true as const,
    })),
    ...emotions.map((e) => ({ ...e, builtin: false as const })),
  ];

  return (
    <SectionCard
      title="Emotions"
      badge={`${all.length} presets`}
    >
      <div style={{ marginBottom: 10 }}>
        {all.map((e) => (
          <EmotionRow
            key={`${e.builtin ? "builtin" : "custom"}:${e.name}`}
            ui={ui}
            e={e}
            builtin={e.builtin}
            onTest={handleTest}
            onDelete={setPendingDelete}
          />
        ))}
      </div>

      <input ref={fileRef} type="file" accept=".vrma" multiple onChange={handleFile} style={{ display: "none" }} />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={importing}
        className="dropzone-btn"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
        <span>{importing ? (importProgress ?? "Importing...") : "Import .vrma from Blender"}</span>
      </button>

      {error && <div className="error-banner">{error}</div>}

      {pendingDelete && (
        <ConfirmModal
          title="Delete emotion?"
          message={`Delete "${pendingDelete}"? This cannot be undone.`}
          busy={deleting}
          onClose={() => !deleting && setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </SectionCard>
  );
}
