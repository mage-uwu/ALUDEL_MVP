import { useEffect, useId, useRef, useState } from "react";
import { VAULT_DELETE_CONFIRMATION } from "../shared/vault";

/** Temporary beta reset; remove alongside DELETE /vault/reports. */
export function VaultDeleteDialog({ teamName, onDelete, onClose }: {
  teamName: string;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), submitting = useRef(false);
  const id = useId();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const remove = async () => {
    if (confirmation !== VAULT_DELETE_CONFIRMATION || submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try { await onDelete(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete Vault history. Try again."); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="modal vault-delete-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={e => { e.preventDefault(); if (!submitting.current) onClose(); }}>
    <form onSubmit={e => { e.preventDefault(); void remove(); }}>
      <h2 id={`${id}-title`} className="modal-title">Delete all Vault history?</h2>
      <p id={`${id}-description`} className="modal-msg">
        Permanently delete every report and original file in <strong>{teamName}</strong>, plus pending documents and import history.
        This includes records outside the current filters. Sites, templates and Field forms stay available. This cannot be undone.
      </p>
      <label className="field">
        <span>Type <strong>{VAULT_DELETE_CONFIRMATION}</strong> to confirm</span>
        <input className="vault-input" autoFocus autoComplete="off" spellCheck={false} value={confirmation}
          disabled={busy} onChange={e => setConfirmation(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="big-btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="big-btn danger" type="submit" disabled={busy || confirmation !== VAULT_DELETE_CONFIRMATION}>
          {busy ? "Deleting…" : "Delete all"}
        </button>
      </div>
    </form>
  </dialog>;
}
