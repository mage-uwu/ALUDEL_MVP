import { useEffect, useId, useRef, useState } from "react";
import { SITES_DELETE_CONFIRMATION } from "../shared/sites";

/** Temporary beta cleanup; remove alongside DELETE /sites. */
export function SitesDeleteDialog({ teamName, onDelete, onClose }: {
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
    if (confirmation !== SITES_DELETE_CONFIRMATION || submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try { await onDelete(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete sites. Try again."); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="modal vault-delete-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={e => { e.preventDefault(); if (!submitting.current) onClose(); }}>
    <form onSubmit={e => { e.preventDefault(); void remove(); }}>
      <h2 id={`${id}-title`} className="modal-title">Permanently delete all sites?</h2>
      <p id={`${id}-description`} className="modal-msg">
        Delete every site in <strong>{teamName}</strong>, whether listed or unlisted, along with their Field dispatches and the saved route plan.
        Lists, templates and historical paperwork in Vault are kept. Site deletion cannot be undone.
      </p>
      <label className="field">
        <span>Type <strong>{SITES_DELETE_CONFIRMATION}</strong> to confirm</span>
        <input className="vault-input" autoFocus autoComplete="off" spellCheck={false} value={confirmation}
          disabled={busy} onChange={e => setConfirmation(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button className="big-btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="big-btn danger" type="submit" disabled={busy || confirmation !== SITES_DELETE_CONFIRMATION}>
          {busy ? "Deleting…" : "Delete all sites"}
        </button>
      </div>
    </form>
  </dialog>;
}
