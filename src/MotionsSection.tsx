// Motions settings section — port of the host organism
// app/src/ui/organisms/MotionsSection.tsx. Tauri invoke/emit become the
// plugin backend api and namespaced ctx.events; built-in motion metadata is
// inlined from the engine's idle/registry.ts; the idle checkboxes drive the
// idle-mixer config (see useIdleMixer.ts).

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { PluginContext } from "../../sdk/js/@companion/plugin";
import {
  makeLibraryApi,
  useVrmaImport,
  type MotionSummary,
} from "./backend";
import { callWithRetry } from "./retry";
import { useIdleMixer } from "./useIdleMixer";
import { RenameModal } from "./RenameModal";

// From app/src/idle/registry.ts — the built-in clips hardcoded in motion.ts.
const BUILTIN_MOTION_DESCRIPTIONS: Record<string, string> = {
  none: "stay still idle, default when no motion fits",
  nod: "head nod for yes agreement",
  shake: "head shake for no disagreement",
  think: "thoughtful head tilt while thinking",
};

const BUILTIN_MOTION_META: Array<{ name: string; duration: number }> = [
  { name: "nod", duration: 1.1 },
  { name: "shake", duration: 1.1 },
  { name: "think", duration: 2.2 },
];

function MotionRow({ ctx, m, builtin, idleChecked, onToggleIdle, onTest, onDelete, onChanged, reportError }: {
  ctx: PluginContext;
  m: MotionSummary;
  builtin?: boolean;
  idleChecked: boolean;
  onToggleIdle: () => void;
  onTest: (name: string) => void;
  onDelete?: (name: string) => void;
  onChanged?: () => void;
  reportError?: (msg: string | null) => void;
}) {
  const { Button, TextInput } = ctx.ui;
  const api = makeLibraryApi(ctx);
  const [desc, setDesc] = useState(m.description ?? "");
  const [savingDesc, setSavingDesc] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(m.name);
  const [busyRename, setBusyRename] = useState(false);
  useEffect(() => { setDesc(m.description ?? ""); }, [m.description]);

  const descDirty = (desc ?? "").trim() !== (m.description ?? "").trim();

  const saveDesc = async () => {
    if (builtin || !onChanged || !reportError) return;
    setSavingDesc(true);
    reportError(null);
    try {
      await api.updateMotionDescription(m.name, desc.trim());
      ctx.events.emit("motion-library-changed");
      onChanged();
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDesc(false);
    }
  };

  const confirmRename = async () => {
    if (builtin || !onChanged || !reportError) return;
    const target = newName.trim();
    if (!target || target === m.name) {
      setRenaming(false);
      return;
    }
    setBusyRename(true);
    reportError(null);
    try {
      await api.renameMotion(m.name, target);
      ctx.events.emit("motion-library-changed");
      setRenaming(false);
      onChanged();
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRename(false);
    }
  };

  return (
    <div className="item-row" style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label title="Use as idle motion" style={{ display: "flex", alignItems: "center", cursor: "pointer", flexShrink: 0 }}>
          <input type="checkbox" checked={idleChecked} onChange={onToggleIdle} />
        </label>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="item-title">{m.name}</div>
          <div className="item-meta">{m.duration.toFixed(1)}s clip{builtin ? " • built-in" : ""}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <Button variant="primary" onClick={() => onTest(m.name)} style={{ padding: "5px 10px", fontSize: 11 }}>
            Test
          </Button>
          {!builtin && (
            <>
              <Button variant="secondary" onClick={() => { setNewName(m.name); setRenaming(true); }} style={{ padding: "5px 10px", fontSize: 11 }}>
                Rename
              </Button>
              <Button variant="danger" onClick={() => onDelete?.(m.name)} style={{ padding: "5px 10px", fontSize: 11 }}>
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <TextInput
          value={desc}
          maxLength={280}
          disabled={builtin}
          placeholder="Describe this motion for the AI, e.g. energetic bow with arm sweep"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDesc(e.target.value)}
          style={{ flex: 1, fontSize: 12 }}
        />
        {!builtin && (
          <Button variant="secondary" onClick={saveDesc} disabled={!descDirty || savingDesc} style={{ padding: "5px 10px", fontSize: 11, flexShrink: 0 }}>
            {savingDesc ? "Saving..." : "Save"}
          </Button>
        )}
      </div>
      {!builtin && renaming && (
        <RenameModal
          ui={ctx.ui}
          title="Rename motion"
          message={`Linked emotions named "${m.name}_..." rename too. Letters, numbers, _ and - only.`}
          value={newName}
          busy={busyRename}
          onChange={setNewName}
          onConfirm={confirmRename}
          onClose={() => { if (!busyRename) setRenaming(false); }}
        />
      )}
    </div>
  );
}

export function MotionsSection({ ctx }: { ctx: PluginContext }) {
  const { SectionCard, ConfirmModal } = ctx.ui;
  const api = makeLibraryApi(ctx);
  const { importFile, vrmaFiles } = useVrmaImport(ctx);
  const [motions, setMotions] = useState<MotionSummary[]>([]);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [idleCfg, updateIdle] = useIdleMixer();

  const refresh = async () => {
    try {
      // Retry wraps the read: backend invokes issued right after a plugin
      // (re)enable occasionally never resolve on macOS (see retry.ts).
      const list = await callWithRetry(
        () => api.listMotionSummaries(),
        ctx.log,
        "vrm.list_motion_summaries",
      );
      setMotions(list);
    } catch (e) {
      console.error("vrm.list_motion_summaries failed", e);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const toggleIdle = (name: string) => {
    const has = idleCfg.idleMotions.includes(name);
    updateIdle({
      ...idleCfg,
      idleMotions: has
        ? idleCfg.idleMotions.filter((n) => n !== name)
        : [...idleCfg.idleMotions, name],
    });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteMotion(pendingDelete);
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
    ctx.events.emit("motion-test", name);
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

  const all: Array<MotionSummary & { builtin?: boolean }> = [
    ...BUILTIN_MOTION_META.map((b) => ({
      name: b.name,
      duration: b.duration,
      description: BUILTIN_MOTION_DESCRIPTIONS[b.name] ?? "",
      builtin: true as const,
    })),
    ...motions.map((m) => ({ ...m, builtin: false as const })),
  ];

  return (
    <SectionCard
      title="Motions"
      badge={`${all.length} clips`}
    >
      <div style={{ marginBottom: 10 }}>
        {all.map((m) => (
          <MotionRow
            key={`${m.builtin ? "builtin" : "custom"}:${m.name}`}
            ctx={ctx}
            m={m}
            builtin={m.builtin}
            idleChecked={idleCfg.idleMotions.includes(m.name)}
            onToggleIdle={() => toggleIdle(m.name)}
            onTest={handleTest}
            onDelete={setPendingDelete}
            onChanged={refresh}
            reportError={setError}
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
          title="Delete motion?"
          message={`Delete "${pendingDelete}"? This cannot be undone.`}
          busy={deleting}
          onClose={() => !deleting && setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </SectionCard>
  );
}
