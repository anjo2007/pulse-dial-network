import app from '../services/api/src/server.js';

export default function handler(req, res) {
  return app(req, res);
}
