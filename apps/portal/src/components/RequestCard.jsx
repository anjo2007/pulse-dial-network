import React, { useEffect, useRef, useState } from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';
import { Badge, ProgressBar } from './ui.jsx';
import {
  assignmentStatusLabel,
  canCancel,
  canClose,
  canEscalate,
  describeRequest,
  displayDonorLabel,
  donorInitials,
  formatDuration,
  formatTime,
  nextRadiusStep,
  rosterSummary,
  statusLabel,
  statusTone,
  summarize,
} from '../lib/lifecycle.js';

/**
 * Radar: decoration only. The accessible description of a request lives in the card
 * heading and the roster list, so assistive tech never has to interpret a picture.
 */
export function DispatchRadar({ request, summary }) {
  const circles = [1, 5, 15];
  return (
    <div className="radar" aria-hidden="true">
      <div className="hospital-dot">+</div>
      {circles.map((radius, index) => (
        <div key={radius} className={`ring ring-${index} ${request.currentRadiusKm >= radius ? 'active' : ''}`}>
          <span>{radius} km</span>
        </div>
      ))}
      {request.assignments.slice(0, 8).map((assignment, index) => (
        <div
          key={assignment.id}
          className={`donor-dot ${assignment.status.toLowerCase()}`}
          style={{ left: `${18 + ((index * 21) % 64)}%`, top: `${23 + ((index * 29) % 58)}%` }}
        />
      ))}
      {summary.fullyCollected ? <div className="radar-badge">COLLECTED</div> : null}
    </div>
  );
}

/**
 * Dispatch roster.
 *
 * Privacy rule: only an on-site donor's legal name is shown. Everyone else appears as
 * a stable reference (Donor #A1B2) plus the clinically required blood group.
 */
export function DispatchRoster({ request }) {
  const entries = request.assignments;
  const summary = rosterSummary(entries);
  return (
    <div className="roster">
      <div className="roster-title">
        Dispatch roster <span>{entries.length} donors</span>
        <span className="sr-only">
          {`${summary.pinged} alerted, ${summary.responding} responding, ${summary.arrived} on site, ${summary.collected} collected, ${summary.declined} declined.`}
        </span>
      </div>
      {entries.length ? (
        <>
          <ul className="roster-list">
            {entries.map((entry) => (
              <li className="roster-row" key={entry.id}>
                <span className="avatar" aria-hidden="true">
                  {donorInitials(entry)}
                </span>
                <b>
                  {displayDonorLabel(entry)}
                  {entry.status === 'PINGED' ? <em className="privacy-note"> identity at check-in</em> : null}
                </b>
                <span>{entry.donorBloodType || request.bloodType}</span>
                <span>{entry.distanceKm} km</span>
                <Badge tone={entry.status === 'COMPLETED' ? 'green' : entry.status === 'DECLINED' ? 'gray' : entry.status === 'PINGED' ? 'blue' : 'amber'}>
                  {assignmentStatusLabel(entry.status)}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="roster-footnote">
            Donor identities are revealed once the donor arrives. Until then the portal only holds a non-identifying
            reference and the blood group needed for matching.
          </p>
        </>
      ) : (
        <p className="empty">No eligible nearby donors in this radius. Expand the search.</p>
      )}
    </div>
  );
}

function CardAction({ label, pendingLabel, busy, disabled, disabledReason, className, onClick }) {
  return (
    <>
      <button type="button" className={className} onClick={onClick} disabled={busy || disabled} aria-busy={busy || undefined}>
        {busy ? pendingLabel : label}
      </button>
      {disabled && disabledReason ? <span className="action-hint">{disabledReason}</span> : null}
    </>
  );
}

export default function RequestCard({ request, now, capabilities, onEscalate, onClose, onCancel }) {
  const summary = summarize(request, now);
  const [dialog, setDialog] = useState(null);
  const [pendings, setPendings] = useState({});
  const [actionError, setActionError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const escalateStep = nextRadiusStep(request.currentRadiusKm);
  const escalatable = canEscalate(request);
  const closable = canClose(request);
  const cancellable = canCancel(request, capabilities);

  async function run(name, task, { keepDialogOpen = false } = {}) {
    if (pendings[name]) return;
    setActionError('');
    setDialogError('');
    setPendings((previous) => ({ ...previous, [name]: true }));
    try {
      await task(request.id);
      if (mountedRef.current && keepDialogOpen) setDialog(null);
    } catch (error) {
      const message = error?.message || 'That action could not be completed. Try again.';
      if (keepDialogOpen) setDialogError(message);
      else setActionError(message);
    } finally {
      if (mountedRef.current) setPendings((previous) => ({ ...previous, [name]: false }));
    }
  }

  const createdLabel = formatTime(request.createdAt);
  const cardId = `request-${request.id}`;

  return (
    <article className="request-card" aria-labelledby={cardId}>
      <header>
        <div>
          <Badge tone={request.urgency === 'CRITICAL' ? 'red' : request.urgency === 'URGENT' ? 'amber' : 'blue'}>
            {request.urgency}
          </Badge>
          <h3 id={cardId} tabIndex={-1}>
            {request.bloodType || 'Unspecified'} <span>blood needed</span>
          </h3>
          <p>
            {request.unitsNeeded} unit{request.unitsNeeded === 1 ? '' : 's'} requested · raised {createdLabel}
          </p>
          <p className="sr-only">{describeRequest(request, now)}</p>
        </div>
        <div className="card-status">
          <Badge tone={statusTone(request, now)}>{statusLabel(request, now)}</Badge>
          {closable && summary.expiresAtMs ? (
            <small className={summary.expired ? 'overdue' : 'muted'}>
              {summary.expired
                ? `Dispatch window ended ${formatDuration(Math.abs(summary.expiresInMs))} ago`
                : `Dispatch window closes in ${formatDuration(summary.expiresInMs)}`}
            </small>
          ) : null}
        </div>
      </header>

      <div className="request-body">
        <DispatchRadar request={request} summary={summary} />
        <div className="metrics">
          <div>
            <strong>{summary.pinged}</strong>
            <span>alerted</span>
          </div>
          <div>
            <strong>{summary.responding}</strong>
            <span>responding</span>
          </div>
          <div>
            <strong>
              {summary.collected}/{summary.needed}
            </strong>
            <span>collected</span>
          </div>

          <ProgressBar
            value={summary.collected}
            max={summary.needed}
            tone={summary.fullyCollected ? 'green' : 'blue'}
            label={`${summary.collected} of ${summary.needed} units collected`}
          />

          <p>
            Dispatch perimeter <b>{request.currentRadiusKm} km</b>
            {summary.declined ? ` · ${summary.declined} declined` : ''}
            {summary.enRoute ? ` · ${summary.enRoute} en route` : ''}
            {summary.arrived ? ` · ${summary.arrived} on site` : ''}
          </p>

          <div className="card-actions">
            {closable ? (
              <CardAction
                label={escalateStep ? `Expand radius to ${escalateStep} km →` : 'Maximum radius reached'}
                pendingLabel="Expanding…"
                busy={Boolean(pendings.escalate)}
                disabled={!escalatable}
                disabledReason={escalateStep ? '' : 'The search already covers the widest perimeter.'}
                className="secondary"
                onClick={() => run('escalate', onEscalate)}
              />
            ) : null}
            {closable ? (
              <CardAction
                label={summary.fullyCollected ? 'Mark as fulfilled' : 'End dispatch…'}
                pendingLabel="Closing…"
                busy={Boolean(pendings.close)}
                className="link-button"
                onClick={() => {
                  setDialogError('');
                  setDialog('close');
                }}
              />
            ) : null}
            {cancellable ? (
              <CardAction
                label="Cancel request…"
                pendingLabel="Cancelling…"
                busy={Boolean(pendings.cancel)}
                className="link-button danger-link"
                onClick={() => {
                  setDialogError('');
                  setDialog('cancel');
                }}
              />
            ) : null}
          </div>

          {actionError ? (
            <p className="inline-error" role="alert">
              {actionError}
            </p>
          ) : null}
        </div>
      </div>

      <DispatchRoster request={request} />

      <ConfirmDialog
        open={dialog === 'close'}
        title={summary.fullyCollected ? 'Mark this request as fulfilled?' : 'End dispatch for this request?'}
        description={
          summary.fullyCollected
            ? `${summary.collected} of ${summary.needed} units are collected. The request will be closed as FULFILLED and no further donors will be alerted.`
            : `Only ${summary.collected} of ${summary.needed} units are collected. Closing now ends the alert for ${summary.pinged} donors; you can raise a new request if more units are needed.`
        }
        confirmLabel={summary.fullyCollected ? 'Mark fulfilled' : 'End dispatch'}
        pending={Boolean(pendings.close)}
        error={dialogError}
        tone="danger"
        onCancel={() => (pendings.close ? null : setDialog(null))}
        onConfirm={() => run('close', onClose, { keepDialogOpen: true })}
      />

      <ConfirmDialog
        open={dialog === 'cancel'}
        title="Cancel this emergency request?"
        description={`The alert sent to ${summary.pinged} donor${summary.pinged === 1 ? '' : 's'} will be withdrawn and the request marked CANCELLED. This cannot be undone.`}
        confirmLabel="Cancel request"
        cancelLabel="Keep dispatching"
        pending={Boolean(pendings.cancel)}
        error={dialogError}
        tone="danger"
        onCancel={() => (pendings.cancel ? null : setDialog(null))}
        onConfirm={() => run('cancel', onCancel, { keepDialogOpen: true })}
      />
    </article>
  );
}
