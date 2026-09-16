import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

/**
 * Component render verification.
 *
 * Components are loaded through the project's own Vite install (the same pipeline the
 * build uses) and rendered with react-dom/server, so this suite runs with zero extra
 * dependencies while still asserting real markup: landmarks, labels, loading states,
 * capability gating and - most importantly - that donor identities are masked.
 */

let server;
let App;
let CheckIn;
let Dashboard;
let RequestCard;

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const UUID_A = '8a0d0f2e-1c3a-4f5b-9a11-2b3c4d5e6f70';
const UUID_B = '11112222-3333-4444-5555-666677778888';

test.before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: 'vite.config.js',
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });
  App = (await server.ssrLoadModule('/src/App.jsx')).default;
  CheckIn = (await server.ssrLoadModule('/src/components/CheckIn.jsx')).default;
  Dashboard = (await server.ssrLoadModule('/src/components/Dashboard.jsx')).default;
  RequestCard = (await server.ssrLoadModule('/src/components/RequestCard.jsx')).default;
});

test.after(async () => {
  await server?.close();
});

const render = (element) => renderToStaticMarkup(element);

const request = (overrides = {}) => ({
  id: 'req-1',
  bloodType: 'O-',
  unitsNeeded: 2,
  urgency: 'CRITICAL',
  status: 'DISPATCHING',
  currentRadiusKm: 1,
  createdAt: new Date(NOW - 60000).toISOString(),
  expiresAt: new Date(NOW + 1800000).toISOString(),
  assignments: [],
  pinged: 0,
  accepted: 0,
  fulfilledUnits: 0,
  ...overrides,
});

const assignment = (overrides = {}) => ({
  id: 'asg-1',
  donorId: UUID_A,
  donorName: 'Asha Menon',
  donorBloodType: 'O-',
  status: 'PINGED',
  tier: 1,
  distanceKm: 1.2,
  notifiedAt: new Date(NOW - 30000).toISOString(),
  hasCheckinToken: false,
  ...overrides,
});

test('the signed-out portal renders an accessible sign-in form', () => {
  const markup = render(React.createElement(App));
  assert.match(markup, /Sign in to dispatch/);
  // React emits these as camelCase in the markup; HTML attribute names are case-insensitive.
  assert.match(markup, /autocomplete="username"/i);
  assert.match(markup, /autocomplete="current-password"/i);
  assert.match(markup, /type="password"/);
  assert.match(markup, /Keep me signed in on this device/);
  // No credential may be present in the DOM before the user asks for it.
  assert.doesNotMatch(markup, /demo123/);
  assert.doesNotMatch(markup, /value="admin@centralhospital\.demo"/);
  assert.doesNotMatch(markup, /PULSE DIAl/);
});

test('the request card masks donor identity and gates cancellation', () => {
  const withCapability = render(
    React.createElement(RequestCard, {
      request: request({
        assignments: [
          assignment({ id: 'asg-pinged', donorId: UUID_A, donorName: 'Asha Menon', status: 'PINGED' }),
          assignment({ id: 'asg-done', donorId: UUID_B, donorName: 'Ravi Nair', status: 'COMPLETED' }),
        ],
      }),
      now: NOW,
      capabilities: { cancelRequest: true },
      onEscalate: async () => {},
      onClose: async () => {},
      onCancel: async () => {},
    }),
  );

  assert.match(withCapability, /Donor #/, 'a non-identifying reference must be rendered');
  assert.doesNotMatch(withCapability, /Asha Menon/, 'a donor who has not arrived must not be named');
  assert.match(withCapability, /Ravi Nair/, 'a donor who completed the donation is identified for the record');
  assert.match(withCapability, />Alerted</);
  assert.match(withCapability, />Collected</);
  assert.match(withCapability, /Expand radius to 5 km/);
  assert.match(withCapability, /Cancel request/);
  assert.match(withCapability, /role="progressbar"/);
  assert.match(withCapability, /aria-labelledby="request-req-1"/);

  const withoutCapability = render(
    React.createElement(RequestCard, {
      request: request({ assignments: [assignment()] }),
      now: NOW,
      capabilities: { cancelRequest: false },
      onEscalate: async () => {},
      onClose: async () => {},
      onCancel: async () => {},
    }),
  );
  assert.doesNotMatch(withoutCapability, /Cancel request/, 'no cancel action without the server capability');
  assert.match(withoutCapability, /End dispatch/);
});

test('a closed request offers no dispatch actions', () => {
  const markup = render(
    React.createElement(RequestCard, {
      request: request({ status: 'FULFILLED', assignments: [assignment({ status: 'COMPLETED' })] }),
      now: NOW,
      capabilities: { cancelRequest: true },
      onEscalate: async () => {},
      onClose: async () => {},
      onCancel: async () => {},
    }),
  );
  assert.doesNotMatch(markup, /Expand radius/);
  assert.doesNotMatch(markup, /End dispatch/);
  assert.doesNotMatch(markup, /Cancel request/);
  assert.match(markup, /Fulfilled/);
});

test('the check-in form is labelled and cannot submit while empty', () => {
  const markup = render(React.createElement(CheckIn, { onCheckIn: async () => ({}) }));
  assert.match(markup, /Arrival token/);
  assert.match(markup, /placeholder="e\.g\. 482915 \(or PULSE:assignment-id:token\)"/);
  assert.match(markup, /aria-describedby="[^"]*-hint"/);
  assert.match(markup, /type="submit"[^>]*disabled/);
  assert.match(markup, /Fast donor check-in/);
});

test('the dashboard renders landmarks, loading state and filters before data arrives', () => {
  const api = {
    listRequests: async () => [],
    health: async () => ({ status: 'ok' }),
  };
  const markup = render(
    React.createElement(Dashboard, {
      api,
      session: {
        token: 'tok.en',
        role: 'hospital',
        subjectId: 'hospital-central',
        expiresAtMs: NOW + 3600000,
        hospital: { id: 'hospital-central', name: 'Central City Medical Centre', licenseNumber: 'MH-EMR-2026-0021' },
      },
      onSignOut: () => {},
      onUnauthorized: () => {},
    }),
  );

  assert.match(markup, /Skip to the live dispatch feed/);
  assert.match(markup, /Rapid donor dispatch/);
  assert.match(markup, /New emergency request/);
  assert.match(markup, /Live dispatch radar/);
  assert.match(markup, /Active \(0\)/);
  assert.match(markup, /role="progressbar"|Loading the live dispatch feed/);
  assert.match(markup, /Central City Medical Centre/);
  assert.match(markup, /MH-EMR-2026-0021/);
  // The session token must never be rendered into the document.
  assert.doesNotMatch(markup, /tok\.en/);
});
