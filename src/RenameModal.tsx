// RenameModal (copied from the host's ui/molecules/RenameModal.tsx).
// RenameModal is not part of the shared ctx.ui kit, so it lives in the plugin
// and takes Button/TextInput via the `ui` prop. The modal-* classes are
// global in the settings window.

import { useEffect, type ChangeEvent } from "react";
// Portal via the local host-compat shim: the host shares only
// react-dom/client, whose React 19 entry no longer carries createPortal.
import { createPortal } from "./vendor/react-dom-compat.js";
import type { PluginContext } from "../../sdk/js/@companion/plugin";

type Props = {
  ui: PluginContext["ui"];
  title: string;
  message: string;
  value: string;
  maxLength?: number;
  busy?: boolean;
  confirmLabel?: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export function RenameModal({
  ui,
  title,
  message,
  value,
  maxLength = 64,
  busy,
  confirmLabel = "Rename",
  onChange,
  onConfirm,
  onClose,
}: Props) {
  const { Button, TextInput } = ui;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
      if (e.key === "Enter" && value.trim() && !busy) onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onConfirm, value, busy]);

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="modal-card">
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button
            type="button"
            className="modal-x"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="modal-title">{title}</div>
        <div className="modal-msg" style={{ marginBottom: 12 }}>
          {message}
        </div>
        <div style={{ marginBottom: 20 }}>
          <TextInput
            value={value}
            maxLength={maxLength}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
            style={{ width: "100%" }}
            autoFocus
          />
        </div>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy || !value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
