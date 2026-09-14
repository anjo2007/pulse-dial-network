import React from 'react';

/**
 * Toast stack.
 * Errors are assertive (a failed dispatch action must interrupt); everything else is
 * polite. Every toast is dismissible by keyboard and by click.
 */
export default function Toasts({ toasts, onDismiss }) {
  if (!toasts?.length) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => {
        const isError = toast.tone === 'error';
        return (
          <div
            key={toast.id}
            className={`toast toast-${toast.tone}`}
            role={isError ? 'alert' : 'status'}
            aria-live={isError ? 'assertive' : 'polite'}
          >
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => onDismiss(toast.id)}
              aria-label={`Dismiss notification: ${toast.message}`}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
