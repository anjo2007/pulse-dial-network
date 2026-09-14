import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEOUT_MS,
  createApiClient,
  isAbortError,
  isOfflineError,
  isUnauthorizedError,
  resolveApiBase,
} from '../src/lib/api.js';
import { createPortalApi, parseCapabilities } from '../src/lib/endpoints.js';

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
});

/** Records every call so the HTTP contract can be asserted directly. */
function recordingFetch(response = jsonResponse(200, { ok: true })) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return typeof response === 'function' ? response(url, options) : response;
  };
  impl.calls = calls;
  return impl;
}

test('base url resolution', () => {
  assert.equal(resolveApiBase(undefined), '/api');
  assert.equal(resolveApiBase({}), '/api');
  assert.equal(resolveApiBase({ VITE_API_URL: '   ' }), '/api');
  assert.equal(resolveApiBase({ VITE_API_URL: 'https://api.example.com/' }), 'https://api.example.com');
});

test('request shaping', async (t) => {
  await t.test('a GET carries an Accept header and no body', async () => {
    const fetchImpl = recordingFetch();
    const client = createApiClient({ baseUrl: '/api', fetchImpl });
    const body = await client.get('/health');
    assert.deepEqual(body, { ok: true });
    const [call] = fetchImpl.calls;
    assert.equal(call.url, '/api/health');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers.Accept, 'application/json');
    assert.equal(call.options.headers.Authorization, undefined);
  });

  await t.test('a token becomes a bearer header and a body is serialized once', async () => {
    const fetchImpl = recordingFetch();
    const client = createApiClient({ baseUrl: 'https://api.example.com', fetchImpl });
    await client.post('/hospital/checkin', { token: 'abc.def', body: { token: 'PULSE:1:2' } });
    const [call] = fetchImpl.calls;
    assert.equal(call.url, 'https://api.example.com/hospital/checkin');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers.Authorization, 'Bearer abc.def');
    assert.equal(call.options.headers['Content-Type'], 'application/json');
    assert.equal(call.options.body, JSON.stringify({ token: 'PULSE:1:2' }));
  });

  await t.test('an empty 204 body resolves to undefined instead of throwing', async () => {
    const client = createApiClient({ fetchImpl: recordingFetch(jsonResponse(204)) });
    assert.equal(await client.post('/hospital/requests/x/close'), undefined);
  });
});

test('http failures become typed, user-safe errors', async (t) => {
  const cases = [
    { status: 400, body: { error: 'Blood type and a positive number of units are required.' }, code: 'validation', retryable: false },
    { status: 401, body: { error: 'Please sign in to continue.' }, code: 'unauthorized', retryable: false },
    { status: 403, body: {}, code: 'forbidden', retryable: false },
    { status: 404, body: { error: 'Arrival token was not found.' }, code: 'notFound', retryable: false },
    { status: 409, body: { error: 'Already completed.' }, code: 'conflict', retryable: false },
    { status: 429, body: {}, code: 'rateLimited', retryable: true },
    { status: 500, body: { error: 'The server could not complete that operation. Please try again.' }, code: 'server', retryable: true },
    { status: 503, body: {}, code: 'server', retryable: true },
  ];

  for (const entry of cases) {
    await t.test(`HTTP ${entry.status} -> ${entry.code}`, async () => {
      const client = createApiClient({ fetchImpl: recordingFetch(jsonResponse(entry.status, entry.body)) });
      await assert.rejects(
        () => client.get('/hospital/requests'),
        (error) => {
          assert.equal(error.name, 'ApiError');
          assert.equal(error.status, entry.status);
          assert.equal(error.code, entry.code);
          assert.equal(error.retryable, entry.retryable);
          assert.equal(error.path, '/hospital/requests');
          assert.ok(error.message.length > 0);
          return true;
        },
      );
    });
  }

  await t.test('a server error message is preserved, a missing one falls back to copy', async () => {
    const withMessage = createApiClient({ fetchImpl: recordingFetch(jsonResponse(409, { error: 'Stale state.' })) });
    await assert.rejects(() => withMessage.post('/hospital/requests/x/close'), /Stale state\./);

    const withoutMessage = createApiClient({ fetchImpl: recordingFetch(jsonResponse(418)) });
    await assert.rejects(() => withoutMessage.get('/nope'), /HTTP 418/);
  });

  await t.test('an HTML/proxy error page never crashes JSON parsing', async () => {
    const client = createApiClient({ fetchImpl: recordingFetch(jsonResponse(502, '<html>Bad gateway</html>')) });
    await assert.rejects(
      () => client.get('/hospital/requests'),
      (error) => {
        assert.equal(error.code, 'server');
        assert.match(error.message, /temporarily unavailable/i);
        return true;
      },
    );
  });

  await t.test('a 401 is recognisable so the app can end the session', async () => {
    const client = createApiClient({ fetchImpl: recordingFetch(jsonResponse(401, {})) });
    await assert.rejects(
      () => client.get('/hospital/requests'),
      (error) => {
        assert.equal(isUnauthorizedError(error), true);
        assert.match(error.message, /session has expired/i);
        return true;
      },
    );
  });
});

test('transport failures: offline, timeout and cancellation', async (t) => {
  await t.test('a rejected fetch is reported as no connectivity and is retryable', async () => {
    const client = createApiClient({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(
      () => client.get('/hospital/requests'),
      (error) => {
        assert.equal(error.code, 'network');
        assert.equal(isOfflineError(error), true);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  await t.test('a hung request times out and is retryable', async () => {
    const hangUntilAborted = (url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const client = createApiClient({ fetchImpl: hangUntilAborted, timeoutMs: 25 });
    const started = Date.now();
    await assert.rejects(
      () => client.get('/hospital/requests'),
      (error) => {
        assert.equal(error.code, 'timeout');
        assert.equal(error.retryable, true);
        assert.match(error.message, /took too long/i);
        return true;
      },
    );
    assert.ok(Date.now() - started < 2000);
  });

  await t.test('a caller-initiated abort is flagged as cancellation, not failure', async () => {
    const controller = new AbortController();
    const client = createApiClient({
      fetchImpl: async (url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          controller.abort();
        }),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    await assert.rejects(
      () => client.get('/hospital/requests', { signal: controller.signal }),
      (error) => {
        assert.equal(isAbortError(error), true);
        return true;
      },
    );
  });

  await t.test('an already-aborted signal never reaches the network', async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();
    const client = createApiClient({
      fetchImpl: async () => {
        called = true;
        return jsonResponse(200, {});
      },
    });
    await assert.rejects(
      () => client.get('/hospital/requests', { signal: controller.signal }),
      (error) => {
        assert.equal(isAbortError(error), true);
        return true;
      },
    );
    assert.equal(called, false);
  });
});

test('hospital endpoint contract', async (t) => {
  const build = () => {
    const fetchImpl = recordingFetch(jsonResponse(200, {}));
    return { fetchImpl, api: createPortalApi(createApiClient({ baseUrl: '/api', fetchImpl })) };
  };

  await t.test('login posts credentials to /auth/hospital', async () => {
    const { api, fetchImpl } = build();
    await api.login({ email: 'admin@centralhospital.demo', password: 'demo123' });
    const [call] = fetchImpl.calls;
    assert.equal(call.url, '/api/auth/hospital');
    assert.equal(call.options.method, 'POST');
    assert.deepEqual(JSON.parse(call.options.body), { email: 'admin@centralhospital.demo', password: 'demo123' });
  });

  await t.test('the feed is a token-authenticated GET', async () => {
    const { api, fetchImpl } = build();
    await api.listRequests('tok.en');
    const [call] = fetchImpl.calls;
    assert.equal(call.url, '/api/hospital/requests');
    assert.equal(call.options.headers.Authorization, 'Bearer tok.en');
  });

  await t.test('create, escalate, close, cancel and check-in hit the documented paths', async () => {
    const { api, fetchImpl } = build();
    await api.createRequest('t', { bloodType: 'O-', unitsNeeded: 2, urgency: 'CRITICAL' });
    await api.escalateRequest('t', 'req-1');
    await api.closeRequest('t', 'req-1');
    await api.cancelRequest('t', 'req-1');
    await api.checkIn('t', 'PULSE:asg-1:ABCD1234');
    await api.health();

    const paths = fetchImpl.calls.map((call) => `${call.options.method} ${call.url}`);
    assert.deepEqual(paths, [
      'POST /api/hospital/requests',
      'POST /api/hospital/requests/req-1/escalate',
      'POST /api/hospital/requests/req-1/close',
      'POST /api/hospital/requests/req-1/cancel',
      'POST /api/hospital/checkin',
      'GET /api/health',
    ]);
    const checkin = fetchImpl.calls[4];
    assert.deepEqual(JSON.parse(checkin.options.body), { token: 'PULSE:asg-1:ABCD1234' });
    const health = fetchImpl.calls[5];
    assert.equal(health.options.headers.Authorization, undefined);
  });

  await t.test('request ids are URL encoded so a hostile id cannot rewrite the path', async () => {
    const { api, fetchImpl } = build();
    await api.closeRequest('t', 'req/../auth/hospital?x=1');
    assert.equal(fetchImpl.calls[0].url, '/api/hospital/requests/req%2F..%2Fauth%2Fhospital%3Fx%3D1/close');
  });
});

test('capability parsing is opt-in and fail-safe', () => {
  assert.deepEqual(parseCapabilities(undefined), { cancelRequest: false, requestExpiry: false });
  assert.deepEqual(parseCapabilities({ status: 'ok' }), { cancelRequest: false, requestExpiry: false });
  assert.deepEqual(parseCapabilities({ capabilities: 'yes' }), { cancelRequest: false, requestExpiry: false });
  assert.deepEqual(parseCapabilities({ capabilities: { cancelRequest: 'true' } }), { cancelRequest: false, requestExpiry: false });
  assert.deepEqual(parseCapabilities({ capabilities: { cancelRequest: true, requestExpiry: true } }), {
    cancelRequest: true,
    requestExpiry: true,
  });
});
