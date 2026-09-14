import React, { useEffect, useId, useRef } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Accessible confirmation dialog for irreversible dispatch actions.
 *
 * Behaviour that matters for a clinical tool:
 *  - Esc cancels, backdrop click cancels, focus is trapped while open
 *  - focus moves into the dialog and returns to the trigger on close
 *  - initial focus lands on "Cancel" so a stray Enter cannot end a live dispatch
 *  - while the action runs the dialog stays open and every control is locked
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  pending = false,
  error = '',
  tone = 'danger',
  onConfirm,
  onCancel,
  children,
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const returnFocusRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const doc = typeof document === 'undefined' ? null : document;
    returnFocusRef.current = doc ? doc.activeElement : null;
    const focusTimer = setTimeout(() => cancelRef.current?.focus(), 0);

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (!pending) onCancel?.();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    doc?.addEventListener('keydown', handleKeyDown, true);
    return () => {
      clearTimeout(focusTimer);
      doc?.removeEventListener('keydown', handleKeyDown, true);
      const target = returnFocusRef.current;
      if (doc && target && typeof target.focus === 'function' && doc.contains(target)) target.focus();
    };
  }, [open, pending, onCancel]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel?.();
      }}
    >
      <div
        className={`dialog dialog-${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        ref={dialogRef}
      >
        <h2 id={titleId}>{title}</h2>
        {description ? (
          <p id={descriptionId} className="muted">
            {description}
          </p>
        ) : null}
        {children}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onCancel} disabled={pending} ref={cancelRef}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'danger' : 'secondary'}
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
