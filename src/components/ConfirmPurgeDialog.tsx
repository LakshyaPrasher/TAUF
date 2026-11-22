import { useEffect, useId, useRef } from "react";
import { Trash2, X } from "lucide-react";
import { bindDialogLightDismiss, closeModalDialog } from "../lib/topLayer";

interface ConfirmPurgeDialogProps {
  open: boolean;
  caseName: string | null;
  totalCases: number;
  busy: boolean;
  onClose: () => void;
  onPurgeCurrent: () => Promise<void>;
  onPurgeAll: () => Promise<void>;
}

export function ConfirmPurgeDialog({
  open,
  caseName,
  totalCases,
  busy,
  onClose,
  onPurgeCurrent,
  onPurgeAll,
}: ConfirmPurgeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    return bindDialogLightDismiss(dialog, onClose);
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      void closeModalDialog(dialog);
    }
  }, [open]);

  const handleClose = () => {
    void closeModalDialog(dialogRef.current);
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog modal-confirm"
      aria-labelledby={titleId}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <div className="modal-head">
        <div>
          <h2 id={titleId} className="modal-title">
            Purge local case data
          </h2>
          <p className="modal-sub">
            Permanently deletes graphs, pivot trails, and findings from the
            local SQLite database.
          </p>
        </div>
        <button
          type="button"
          className="icon-ctrl"
          onClick={handleClose}
          aria-label="Close dialog"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="confirm-actions">
        {caseName && (
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={async () => {
              await onPurgeCurrent();
              handleClose();
            }}
          >
            <Trash2 size={15} strokeWidth={1.5} />
            <span>Purge "{caseName}"</span>
          </button>
        )}
        <button
          type="button"
          className="btn-danger-outline"
          disabled={busy || totalCases === 0}
          onClick={async () => {
            await onPurgeAll();
            handleClose();
          }}
        >
          <span>Purge all local cases ({totalCases})</span>
        </button>
        <button
          type="button"
          className="btn-ghost-sm"
          disabled={busy}
          onClick={handleClose}
        >
          Cancel
        </button>
      </div>
    </dialog>
  );
}
