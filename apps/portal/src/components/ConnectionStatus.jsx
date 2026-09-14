import React from 'react';
import { connectionCopy } from '../lib/poller.js';

const TRANSPORT_PREFIX = '· ';

function ageLabel(lastSuccessAt, now) {
  if (!lastSuccessAt) return 'waiting for first update';
  const seconds = Math.max(0, Math.round((now - lastSuccessAt) / 1000));
  if (seconds < 5) return 'updated just now';
  if (seconds < 90) return `updated ${seconds}s ago`;
  return `updated ${Math.round(seconds / 60)}m ago`;
}

/**
 * Live-feed indicator.
 *
 * The authoritative status for assistive tech is a polite live region whose text only
 * changes when the connection state changes; the ticking "updated 4s ago" caption is
 * decorative so it is not re-announced on every poll.
 */
export default function ConnectionStatus({ status, lastSuccessAt, now, onRefresh, refreshing, realtime }) {
  const copy = connectionCopy(status, { lastSuccessAt, now });
  return (
    <div className={`live connection status-${copy.tone}`} data-status={status} data-transport={realtime?.label ?? 'Polling'}>
      <span className={`dot dot-${copy.tone}`} aria-hidden="true" />
      <span className="connection-title">{copy.title}</span>
      {realtime ? (
        <span className="connection-transport" aria-hidden="true">
          {TRANSPORT_PREFIX}
          {realtime.label}
        </span>
      ) : null}
      <span className="connection-age" aria-hidden="true">
        {ageLabel(lastSuccessAt, now)}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {`Live dispatch feed: ${copy.title}. ${copy.detail}`}
        {realtime ? ` Transport: ${realtime.label}. ${realtime.detail}` : ''}
      </span>
      {onRefresh ? (
        <button type="button" className="text-button connection-refresh" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </button>
      ) : null}
    </div>
  );
}
