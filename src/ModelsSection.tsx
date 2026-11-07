// Models settings section — port of the host organism
// app/src/ui/organisms/ModelsSection.tsx. Tauri invoke/emit become the plugin
// backend api and namespaced ctx.events; the UI kit comes from ctx.ui and the
// shared settings.css classes (item-row, model-thumb, dropzone-btn,
// error-banner) are global in the settings window.

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import { arrayBufferToBase64, makeLibraryApi, type ModelMeta } from "./backend";
import { callWithRetry } from "./retry";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function ModelsSection({ ctx }: { ctx: PluginContext }) {
  const { SectionCard, Button, ConfirmModal } = ctx.ui;
  const api = makeLibraryApi(ctx);
  const [models, setModels] = useState<ModelMeta[]>([]);
  const [activeId, setActiveId] = useState<string>("builtin:demo");
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const thumbsInFlight = useRef<Set<string>>(new Set());

  // Boot reads go through callWithRetry: right after a plugin (re)enable the
  // webview is busy evaluating the freshly imported bundle, and macOS
  // occasionally drops backend invokes issued in that window (see
  // retry.ts). Without the retry the library stayed empty until the next
  // upload-triggered refresh.
  const refresh = async () => {
    try {
      const list = await callWithRetry(
        () => api.listModels(),
        ctx.log,
        "vrm.list_models",
      );
      setModels(list);
      const active = await callWithRetry(
        () => api.getActiveModel(),
        ctx.log,
        "vrm.get_active_model",
      );
      if (active) {
        setActiveId(active);
      } else if (list.length > 0) {
        setActiveId(list[0].id);
      }
    } catch (e) {
      console.error("vrm.list_models failed", e);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Self-heal: the settings window parks hidden on close and macOS may eat
  // in-flight backend responses along the way. Re-reading the (cheap)
  // library on focus/visibility restores the list without a manual upload.
  useEffect(() => {
    const onWake = () => {
      if (!document.hidden) void refresh();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch each model's avatar image once per mount; null entries are kept
  // so models without a thumbnail don't get re-probed on every refresh.
  // Builtin ids resolve server-side to the staged demo thumb in the plugin
  // package assets. Probes retry like every boot read (retry.ts) — a lost
  // probe would otherwise pin the fallback icon for the session.
  useEffect(() => {
    models.forEach(async (m) => {
      if (thumbsInFlight.current.has(m.id)) return;
      thumbsInFlight.current.add(m.id);
      let url: string | null = null;
      try {
        url = await callWithRetry(
          () => api.modelThumbnail(m.id),
          ctx.log,
          "vrm.model_thumbnail",
        );
      } catch {
        url = null;
      }
      setThumbs((prev) => ({ ...prev, [m.id]: url }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  const handleSelect = async (id: string) => {
    try {
      await api.setActiveModel(id);
      setActiveId(id);
      // The plugin runtime (main window) picks this up and loads the model
      // through the avatar bus.
      ctx.events.emit("model-changed", { id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const arrayBuf = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuf);
      const name = file.name.replace(/\.[^/.]+$/, "");
      const meta = await api.saveModel(name, base64);
      await handleSelect(meta.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // window.confirm never surfaces a dialog inside a Tauri webview, so the
  // delete would silently do nothing. Confirmation goes through the app's own
  // modal, like every other destructive action.
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteModel(id);
      if (activeId === id) {
        // Never leave the app pointed at a file that no longer exists.
        await handleSelect("builtin:demo");
      }
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const activeModel = models.find((m) => m.id === activeId);

  return (
    <SectionCard
      title="Avatar Library"
      badge={activeModel ? activeModel.name : "Active: Default"}
    >
      <div style={{ marginBottom: 12 }}>
        {models.map((m) => {
          const isActive = m.id === activeId;
          return (
            <div
              key={m.id}
              className={`item-row ${isActive ? "item-row-active" : ""}`}
            >
              {thumbs[m.id] ? (
                <img
                  className="model-thumb"
                  src={thumbs[m.id]!}
                  alt=""
                  draggable={false}
                />
              ) : (
                <div className="model-thumb model-thumb-fallback" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0 2c-3.9 0-7 2.24-7 5v2h14v-2c0-2.76-3.1-5-7-5z" /></svg>
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="item-title">{m.name}</div>
                <div className="item-meta">
                  {m.is_builtin ? "Built-in preset" : formatBytes(m.size)}
                </div>
              </div>

              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {!isActive ? (
                  <Button
                    variant="primary"
                    onClick={() => handleSelect(m.id)}
                    style={{ padding: "5px 12px", fontSize: 11 }}
                  >
                    Select
                  </Button>
                ) : (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--accent)",
                      padding: "5px 10px",
                    }}
                  >
                    ✓ Active
                  </span>
                )}
                {!m.is_builtin && (
                  <Button
                    variant="danger"
                    onClick={() => setPendingDelete(m.id)}
                    style={{ padding: "5px 10px", fontSize: 11 }}
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".vrm,.glb"
        onChange={handleFile}
        style={{ display: "none" }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="dropzone-btn"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
        <span>{uploading ? "Importing model..." : "Upload .vrm or .glb"}</span>
      </button>

      {error && <div className="error-banner">{error}</div>}

      {pendingDelete && (
        <ConfirmModal
          title="Delete model?"
          message={`Delete "${models.find((m) => m.id === pendingDelete)?.name ?? pendingDelete}"? This cannot be undone.`}
          busy={deleting}
          onClose={() => !deleting && setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </SectionCard>
  );
}
