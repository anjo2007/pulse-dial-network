import app from '../services/api/src/server.js';

// Explicit route transport avoids depending on whether the runtime retains the source URL.
// Only use it when the function receives its bare destination, never to override a real API path.
export function normalizeFunctionUrl(rawUrl) {
  const [path, query = ''] = String(rawUrl || '/api').split('?');
  const params = new URLSearchParams(query);
  const route = params.get('__route');
  params.delete('__route');
  let target = path;
  if ((path === '/api' || path === '/api/') && route) {
    if (!route.startsWith('/') || route.startsWith('//') || /[\\\\?#\u0000-\u001f]/.test(route)) return null;
    target = `/api${route}`;
  }
  return target + (params.size ? `?${params}` : '');
}

export default function handler(req, res) {
  const url = normalizeFunctionUrl(req.url);
  if (url === null) return res.status(400).json({ error: 'Invalid API route.' });
  req.url = url;
  return app(req, res);
}
