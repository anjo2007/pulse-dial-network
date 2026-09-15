import { useCallback, useEffect, useState } from 'react';
import { usePolling } from './usePolling.js';
import { normalizeRequests, sameRequests } from '../lib/lifecycle.js';
import { subscribeEmergencyRequests, subscribeDispatchAssignments } from '../lib/firebase.js';

function mapFirestoreToRequests(rawReqs, rawAsgns) {
  const asgnsByReq = new Map();
  for (const a of rawAsgns) {
    const rId = a.request_id || a.requestId;
    if (!asgnsByReq.has(rId)) asgnsByReq.set(rId, []);
    asgnsByReq.get(rId).push({
      id: a.id,
      donorId: a.donor_id || a.donorId,
      donorName: a.donor_name || a.donorName,
      donorBloodType: a.blood_type || a.donorBloodType || a.bloodType,
      status: a.status || 'PINGED',
      tier: a.tier || 1,
      distanceKm: a.distance_km || a.distanceKm || 1.2,
      notifiedAt: a.created_at || a.notifiedAt,
      respondedAt: a.responded_at || a.respondedAt,
      arrivedAt: a.arrived_at || a.arrivedAt,
      completedAt: a.verified_at || a.completedAt,
      hasCheckinToken: Boolean(a.qr_token || a.checkinToken),
      arrivalOtp: a.arrival_otp,
    });
  }

  return rawReqs.map((r) => ({
    id: r.id,
    bloodType: r.blood_type || r.bloodType,
    unitsNeeded: r.units_required || r.unitsNeeded || 1,
    urgency: r.urgency || 'CRITICAL',
    status: r.status === 'FULFILLED' ? 'FULFILLED' : (r.status === 'ACTIVE' ? 'DISPATCHING' : (r.status || 'DISPATCHING')),
    currentRadiusKm: r.current_radius_km || r.currentRadiusKm || 1,
    createdAt: r.created_at || r.createdAt,
    assignments: asgnsByReq.get(r.id) || [],
  }));
}

/**
 * The hospital request feed.
 *
 * Realtime Firestore sync provides instant two-way updates with donors.
 * Polling serves as the fallback for REST sessions.
 */
export function useRequestsFeed({ api, token, onUnauthorized, intervalMs }) {
  const [requests, setRequests] = useState([]);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [pollError, setPollError] = useState(null);

  // Firestore real-time synchronization
  useEffect(() => {
    if (!token?.includes('.firebase')) return undefined;

    let latestReqs = [];
    let latestAsgns = [];

    const updateCombined = () => {
      const combined = mapFirestoreToRequests(latestReqs, latestAsgns);
      const next = normalizeRequests(combined);
      setRequests((previous) => (sameRequests(previous, next) ? previous : next));
      setInitialLoaded(true);
      setPollError(null);
    };

    const unsubReqs = subscribeEmergencyRequests(
      (reqs) => {
        latestReqs = reqs;
        updateCombined();
      },
      (err) => console.warn('Firestore reqs error:', err)
    );

    const unsubAsgns = subscribeDispatchAssignments(
      (asgns) => {
        latestAsgns = asgns;
        updateCombined();
      },
      (err) => console.warn('Firestore asgns error:', err)
    );

    return () => {
      unsubReqs?.();
      unsubAsgns?.();
    };
  }, [token]);

  const fetchFn = useCallback(
    ({ signal }) => {
      if (token?.includes('.firebase')) {
        return Promise.resolve([]);
      }
      return api.listRequests(token, { signal });
    },
    [api, token]
  );

  const handleData = useCallback((data) => {
    if (!Array.isArray(data) || data.length === 0) {
      setInitialLoaded(true);
      return;
    }
    const next = normalizeRequests(data);
    setRequests((previous) => (sameRequests(previous, next) ? previous : next));
    setInitialLoaded(true);
    setPollError(null);
  }, []);

  const handleError = useCallback((error) => {
    if (!token?.includes('.firebase')) {
      setPollError(error);
    }
  }, [token]);

  const handleUnauthorized = useCallback(() => {
    onUnauthorized?.();
  }, [onUnauthorized]);

  const poll = usePolling({
    fetch: fetchFn,
    onData: handleData,
    onError: handleError,
    onUnauthorized: handleUnauthorized,
    intervalMs,
  });

  return {
    requests,
    setRequests,
    initialLoaded,
    pollError,
    status: poll.status,
    lastSuccessAt: poll.lastSuccessAt,
    inFlight: poll.inFlight,
    refreshNow: poll.refreshNow,
  };
}
