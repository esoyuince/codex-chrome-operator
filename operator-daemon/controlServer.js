'use strict';

const http = require('node:http');
const { ERROR_CODES } = require('./protocol');

const MAX_BODY_BYTES = 1024 * 1024;

function jsonResponse(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': bytes.length,
    'cache-control': 'no-store'
  });
  res.end(bytes);
}

function isAuthorized(req, token) {
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${token}`;
}

function isJsonContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase() === 'application/json';
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('Body too large');
      error.code = ERROR_CODES.BODY_TOO_LARGE;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function startControlServer({ session, token, host = '127.0.0.1', port = 17391 }) {
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/v1/rpc') {
      jsonResponse(res, 404, {
        ok: false,
        error: { code: ERROR_CODES.UNKNOWN_METHOD, message: 'Unknown endpoint.' }
      });
      return;
    }

    if (req.method !== 'POST') {
      jsonResponse(res, 405, {
        ok: false,
        error: { code: ERROR_CODES.METHOD_NOT_ALLOWED, message: 'POST is required.' }
      });
      return;
    }

    if (!isAuthorized(req, token)) {
      jsonResponse(res, 401, {
        ok: false,
        error: { code: ERROR_CODES.AUTH_INVALID, message: 'Invalid bearer token.' }
      });
      return;
    }

    if (!isJsonContentType(req.headers['content-type'])) {
      jsonResponse(res, 415, {
        ok: false,
        error: { code: ERROR_CODES.INVALID_REQUEST, message: 'application/json is required.' }
      });
      return;
    }

    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      jsonResponse(res, 200, await session.handleRpc(body));
    } catch (error) {
      jsonResponse(res, error.code === ERROR_CODES.BODY_TOO_LARGE ? 413 : 400, {
        ok: false,
        error: {
          code: error.code || ERROR_CODES.INVALID_REQUEST,
          message: error.message
        }
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        server,
        host,
        port: address.port,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => (error ? closeReject(error) : closeResolve()));
        })
      });
    });
  });
}

module.exports = {
  startControlServer
};
