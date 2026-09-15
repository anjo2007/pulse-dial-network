import React, { useCallback, useMemo, useState } from 'react';
import CheckIn from './CheckIn.jsx';
import ConnectionStatus from './ConnectionStatus.jsx';
import NewRequest from './NewRequest.jsx';
import RequestCard from './RequestCard.jsx';
import Toasts from './Toasts.jsx';
import { InlineError, SkeletonBlock } from './ui.jsx';
import { useCapabilities } from '../hooks/useCapabilities.js';
import { useRealtimeInvalidation } from '../hooks/useRealtimeInvalidation.js';
import { useRequestsFeed } from '../hooks/useRequestsFeed.js';
import { useTicker } from '../hooks/useTicker.js';
import { useToasts } from '../hooks/useToasts.js';
import { isUnauthorizedError } from '../lib/api.js';
import { POLL_STATUS } from '../lib/poller.js';
import { filterRequests, mergeRequestUpdate, normalizeRequest, sortRequests, summarize } from '../lib/lifecycle.js';
import { formatRemaining, sessionRemainingMs } from '../lib/session.js';
import { createEmergencyRequestDoc, checkInDonorDesk } from '../lib/firebase.js';

const FEED_INTERVAL_MS = 4000;
const FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
];

function focusRequestCard(id) {
  if (typeof document === 'undefined') return;
  // The heading is programmatically focusable so keyboard users land on the new card.
  requestAnimationFrame(() => document.getElementById(`request-${id}`)?.focus?.());
}

/**
 * Emergency dashboard.
 *
 * Data flow: one resilient poller feeds the list; every mutating action goes through
 * `guard`, which funnels a 401 into the session-expiry flow and lets everything else
 * surface inline next to the control that failed.
 */
export default function Dashboard({ api, session, onSignOut, onUnauthorized }) {
  const now = useTicker(1000);
  const { toasts, push, dismiss } = useToasts();
  const [filter, setFilter] = useState('active');

  const feed = useRequestsFeed({
    api,
    token: session.token,
    onUnauthorized,
    intervalMs: FEED_INTERVAL_MS,
  });
  const { capabilities, probed } = useCapabilities({
    api,
    refreshKey: feed.initialLoaded ? 'ready' : 'pending',
  });

  // Optional realtime invalidation. Broadcast signals carry no data - they only mean
  // "refetch" - and polling keeps running underneath as the guaranteed transport.
  const realtime = useRealtimeInvalidation({ api, token: session.token, onInvalidate: feed.refreshNow });

  const guard = useCallback(
    async (task) => {
      try {
        return await task();
      } catch (error) {
        if (isUnauthorizedError(error)) onUnauthorized();
        throw error;
      }
    },
    [onUnauthorized],
  );

  const requests = feed.requests;
  const counts = useMemo(() => {
    const activeRequests = requests.filter((request) => request.status === 'DISPATCHING');
    return {
      active: activeRequests.length,
      closed: requests.length - activeRequests.length,
      total: requests.length,
      responding: activeRequests.reduce((total, request) => total + summarize(request, now).responding, 0),
      collected: activeRequests.reduce((total, request) => total + summarize(request, now).collected, 0),
    };
  }, [requests, now]);

  const visible = useMemo(() => filterRequests(sortRequests(requests), filter), [requests, filter]);

  const offline = feed.status === POLL_STATUS.offline;
  const offlineReason = 'No network connection. Reconnect to raise requests or verify arrivals.';

  const createRequest = useCallback(
    async (payload) => {
      if (session.token?.includes('.firebase')) {
        const created = await createEmergencyRequestDoc({
          hospital: session.hospital,
          bloodType: payload.bloodType,
          unitsNeeded: payload.unitsNeeded,
          urgency: payload.urgency,
        });
        const normalized = normalizeRequest({
          id: created.id,
          bloodType: created.blood_type,
          unitsNeeded: created.units_required,
          urgency: created.urgency,
          status: 'DISPATCHING',
          currentRadiusKm: created.current_radius_km,
          createdAt: created.created_at,
          assignments: [],
        });
        feed.setRequests((previous) => [normalized, ...previous.filter((request) => request.id !== normalized.id)]);
        setFilter('active');
        focusRequestCard(normalized.id);
        push('Emergency request broadcast to Firebase network. Donors are being alerted.', { tone: 'success' });
        feed.refreshNow();
        return normalized;
      }

      const created = await guard(() => api.createRequest(session.token, payload));
      const normalized = normalizeRequest(created);
      if (normalized.id) {
        feed.setRequests((previous) => [normalized, ...previous.filter((request) => request.id !== normalized.id)]);
        setFilter('active');
        focusRequestCard(normalized.id);
      }
      push('Emergency request broadcast. The closest eligible donors are being alerted.', { tone: 'success' });
      feed.refreshNow();
      return normalized;
    },
    [api, feed, guard, push, session.token, session.hospital],
  );

  const escalate = useCallback(
    async (id) => {
      const updated = await guard(() => api.escalateRequest(session.token, id));
      const normalized = normalizeRequest(updated);
      if (normalized.id) feed.setRequests((previous) => previous.map((request) => (request.id === normalized.id ? normalized : request)));
      push(`Dispatch perimeter expanded to ${normalized.currentRadiusKm} km.`, { tone: 'success' });
      feed.refreshNow();
      return normalized;
    },
    [api, feed, guard, push, session.token],
  );

  const closeRequest = useCallback(
    async (id) => {
      const updated = await guard(() => api.closeRequest(session.token, id));
      const normalized = normalizeRequest(updated);
      if (normalized.id) feed.setRequests((previous) => previous.map((request) => (request.id === normalized.id ? normalized : request)));
      push(normalized.status === 'FULFILLED' ? 'Request fulfilled. No further donors will be alerted.' : 'Dispatch ended before all units were collected. Request marked unfulfilled.', { tone: normalized.status === 'FULFILLED' ? 'success' : 'info' });
      feed.refreshNow();
      return normalized;
    },
    [api, feed, guard, push, session.token],
  );

  const cancelRequest = useCallback(
    async (id) => {
      const updated = await guard(() => api.cancelRequest(session.token, id));
      const normalized = normalizeRequest(updated);
      if (normalized.id) {
        feed.setRequests((previous) =>
          previous.map((request) => (request.id === normalized.id ? mergeRequestUpdate(request, updated) : request)),
        );
      }
      push('Request cancelled and donor alerts withdrawn.', { tone: 'success' });
      feed.refreshNow();
      return normalized;
    },
    [api, feed, guard, push, session.token],
  );

  const checkIn = useCallback(
    async (tokenValue) => {
      if (session.token?.includes('.firebase')) {
        const response = await checkInDonorDesk({ token: tokenValue, arrivalOtp: tokenValue });
        push(`Arrival verified for ${response.donorName} (${response.bloodType}).`, { tone: 'success' });
        feed.refreshNow();
        return response;
      }

      const response = await guard(() => api.checkIn(session.token, tokenValue));
      push(
        response?.alreadyCompleted
          ? 'That arrival was already recorded. No duplicate credit applied.'
          : 'Arrival verified and recorded.',
        { tone: response?.alreadyCompleted ? 'info' : 'success' },
      );
      feed.refreshNow();
      return response;
    },
    [api, feed, guard, push, session.token],
  );

  const remaining = sessionRemainingMs(session, now);
  const expiringSoon = remaining > 0 && remaining < 15 * 60 * 1000;

  return (
    <main className="app" id="main-content">
      <a className="skip-link" href="#dispatch-feed">
        Skip to the live dispatch feed
      </a>

      <nav aria-label="Hospital portal">
        <div className="logo" aria-hidden="true">
          <span>+</span> PULSE <em>DIAL</em>
        </div>
        <div className="hospital-name">
          <b>{session.hospital.name}</b>
          <small>Verified · {session.hospital.licenseNumber}</small>
        </div>
        <div className="session-info">
          <span className={expiringSoon ? 'session-expiry overdue' : 'session-expiry muted'}>
            Session expires in {formatRemaining(remaining)}
          </span>
          <button type="button" className="text-button" onClick={() => onSignOut()}>
            Sign out
          </button>
        </div>
      </nav>

      <Toasts toasts={toasts} onDismiss={dismiss} />

      <section className="hero" aria-labelledby="hero-heading">
        <div>
          <p className="eyebrow">EMERGENCY OPERATIONS</p>
          <h1 id="hero-heading">Rapid donor dispatch</h1>
          <p>Issue a verified SOS in seconds. The matching engine prioritises eligible, active local donors.</p>
        </div>
        <div className="hero-status">
          <ConnectionStatus
            status={feed.status}
            lastSuccessAt={feed.lastSuccessAt}
            now={now}
            onRefresh={feed.refreshNow}
            refreshing={feed.inFlight}
            realtime={realtime}
          />
          <b>
            {counts.active} active emergency request{counts.active === 1 ? '' : 's'}
          </b>
          <span>
            {counts.responding} responding · {counts.collected} unit{counts.collected === 1 ? '' : 's'} collected
          </span>
          {realtime.hint ? (
            <span className="realtime-hint" role="status">
              {realtime.hint}
            </span>
          ) : null}
        </div>
      </section>

      <p className="sr-only" role="status" aria-live="polite">
        {counts.active ? `${counts.active} active emergency requests.` : 'No active emergency requests.'}
      </p>

      {feed.pollError && !offline ? (
        <InlineError id="feed-error" message={feed.pollError.message} onRetry={feed.refreshNow} busy={feed.inFlight} />
      ) : null}

      <section className="grid">
        <div className="panel">
          <h2 id="new-request-heading">New emergency request</h2>
          <NewRequest onCreate={createRequest} disabled={offline} disabledReason={offlineReason} />
        </div>
        <CheckIn onCheckIn={checkIn} disabled={offline} disabledReason={offlineReason} />
      </section>

      <section className="requests" id="dispatch-feed" aria-labelledby="feed-heading">
        <div className="feed-head">
          <h2 id="feed-heading">Live dispatch radar</h2>
          <div className="filters" role="group" aria-label="Filter emergency requests">
            {FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`filter${filter === entry.id ? ' active' : ''}`}
                aria-pressed={filter === entry.id}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label} ({counts[entry.id === 'all' ? 'total' : entry.id]})
              </button>
            ))}
          </div>
        </div>

        {!feed.initialLoaded && !feed.pollError ? <SkeletonBlock lines={4} label="Loading the live dispatch feed" /> : null}

        {feed.initialLoaded && !visible.length ? (
          <div className="blank">
            <div aria-hidden="true">♡</div>
            <h3>{filter === 'active' ? 'No active alerts' : 'Nothing to show here'}</h3>
            <p>
              {filter === 'active'
                ? 'Create an emergency request to start a geofenced donor dispatch.'
                : 'No emergency requests match this filter yet.'}
            </p>
            {filter !== 'all' && counts.total > 0 ? (
              <button type="button" className="secondary" onClick={() => setFilter('all')}>
                Show all requests ({counts.total})
              </button>
            ) : null}
          </div>
        ) : null}

        {visible.map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            now={now}
            capabilities={capabilities}
            onEscalate={escalate}
            onClose={closeRequest}
            onCancel={cancelRequest}
          />
        ))}

        {!probed ? (
          <p className="sr-only">
            Checking server capabilities. Cancellation stays hidden until the API confirms it supports it.
          </p>
        ) : null}
      </section>
    </main>
  );
}
