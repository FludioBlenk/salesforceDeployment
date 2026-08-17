const crypto = require('node:crypto');
const express = require('express');

const app = express();
app.use(express.json({ limit: '64kb' }));

const PORT = Number(process.env.PORT || '8080');
const BROKER_API_TOKEN = process.env.BROKER_API_TOKEN || '';
const SF_CLIENT_ID = process.env.BROKER_SF_CLIENT_ID || '';
const SF_CLIENT_SECRET = process.env.BROKER_SF_CLIENT_SECRET || '';
const SF_REDIRECT_URI = process.env.BROKER_SF_REDIRECT_URI || '';
const SESSION_TTL_MINUTES = Number(process.env.SESSION_TTL_MINUTES || '20');

if (!BROKER_API_TOKEN || !SF_CLIENT_ID || !SF_CLIENT_SECRET || !SF_REDIRECT_URI) {
  console.error('Missing required environment variables. Check auth-broker/.env.example');
  process.exit(1);
}

const sessions = new Map();
const states = new Map();

function nowMs() {
  return Date.now();
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function cleanInstanceUrl(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('instanceUrl is required');
  }
  const url = raw.trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(url)) {
    throw new Error('instanceUrl must start with https://');
  }
  return url;
}

function encodeForceSegment(value) {
  return encodeURIComponent(value || '');
}

function makeSfdxAuthUrl({ clientId, clientSecret, refreshToken, instanceUrl }) {
  const host = instanceUrl.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return `force://${encodeForceSegment(clientId)}:${encodeForceSegment(clientSecret)}:${encodeForceSegment(refreshToken)}@${host}`;
}

function authGuard(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!token || token !== BROKER_API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

function getSessionOr404(sessionId, res) {
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: 'session_not_found' });
    return null;
  }

  if (session.expiresAtMs < nowMs() && session.status === 'pending') {
    session.status = 'expired';
    session.updatedAtMs = nowMs();
  }

  return session;
}

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/v1/salesforce/auth/sessions', authGuard, (req, res) => {
  try {
    const repository = (req.body.repository || '').toString().trim();
    const environmentBranch = (req.body.environmentBranch || '').toString().trim();
    const callbackRunUrl = (req.body.callbackRunUrl || '').toString().trim();
    const instanceUrl = cleanInstanceUrl(req.body.instanceUrl || '');

    if (!repository || !environmentBranch) {
      return res.status(400).json({ error: 'repository and environmentBranch are required' });
    }

    const sessionId = crypto.randomUUID();
    const state = crypto.randomUUID();
    const createdAtMs = nowMs();
    const expiresAtMs = createdAtMs + SESSION_TTL_MINUTES * 60 * 1000;

    const authorizeUrl = new URL(`${instanceUrl}/services/oauth2/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', SF_CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', SF_REDIRECT_URI);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('prompt', 'login');

    const session = {
      sessionId,
      state,
      status: 'pending',
      repository,
      environmentBranch,
      callbackRunUrl,
      instanceUrl,
      authorizeUrl: authorizeUrl.toString(),
      sfdxAuthUrl: null,
      error: null,
      createdAtMs,
      updatedAtMs: createdAtMs,
      expiresAtMs,
    };

    sessions.set(sessionId, session);
    states.set(state, sessionId);

    return res.json({
      sessionId,
      status: session.status,
      authorizeUrl: session.authorizeUrl,
      expiresAt: toIso(expiresAtMs),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'invalid_request' });
  }
});

app.get('/api/v1/salesforce/auth/sessions/:sessionId', authGuard, (req, res) => {
  const session = getSessionOr404(req.params.sessionId, res);
  if (!session) {
    return;
  }

  return res.json({
    sessionId: session.sessionId,
    status: session.status,
    authorizeUrl: session.authorizeUrl,
    repository: session.repository,
    environmentBranch: session.environmentBranch,
    callbackRunUrl: session.callbackRunUrl,
    instanceUrl: session.instanceUrl,
    error: session.error,
    sfdxAuthUrl: session.status === 'completed' ? session.sfdxAuthUrl : undefined,
    createdAt: toIso(session.createdAtMs),
    updatedAt: toIso(session.updatedAtMs),
    expiresAt: toIso(session.expiresAtMs),
  });
});

app.get('/oauth/callback', async (req, res) => {
  const state = (req.query.state || '').toString();
  const code = (req.query.code || '').toString();
  const error = (req.query.error || '').toString();

  const sessionId = states.get(state);
  if (!sessionId) {
    return res.status(400).send('Unknown or expired state.');
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(400).send('Unknown session.');
  }

  if (session.expiresAtMs < nowMs()) {
    session.status = 'expired';
    session.updatedAtMs = nowMs();
    return res.status(400).send('Session expired. Please start a new authentication session.');
  }

  if (error) {
    session.status = 'failed';
    session.error = error;
    session.updatedAtMs = nowMs();
    return res.status(400).send(`Salesforce authentication failed: ${error}`);
  }

  if (!code) {
    session.status = 'failed';
    session.error = 'missing_authorization_code';
    session.updatedAtMs = nowMs();
    return res.status(400).send('Missing authorization code.');
  }

  try {
    const tokenUrl = `${session.instanceUrl}/services/oauth2/token`;
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('client_id', SF_CLIENT_ID);
    body.set('client_secret', SF_CLIENT_SECRET);
    body.set('redirect_uri', SF_REDIRECT_URI);
    body.set('code', code);

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      throw new Error(`token_exchange_failed (${tokenResponse.status}): ${text}`);
    }

    const tokenData = await tokenResponse.json();
    if (!tokenData.refresh_token || !tokenData.instance_url) {
      throw new Error('token_exchange_failed: missing refresh_token or instance_url');
    }

    session.sfdxAuthUrl = makeSfdxAuthUrl({
      clientId: SF_CLIENT_ID,
      clientSecret: SF_CLIENT_SECRET,
      refreshToken: tokenData.refresh_token,
      instanceUrl: tokenData.instance_url,
    });
    session.status = 'completed';
    session.updatedAtMs = nowMs();

    return res.status(200).send('Authentication complete. You can return to the GitHub Actions run.');
  } catch (err) {
    session.status = 'failed';
    session.error = err.message || 'token_exchange_failed';
    session.updatedAtMs = nowMs();
    return res.status(500).send(`Authentication callback failed: ${session.error}`);
  }
});

setInterval(() => {
  const now = nowMs();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAtMs + 60 * 60 * 1000 < now) {
      sessions.delete(sessionId);
      states.delete(session.state);
    }
  }
}, 5 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Salesforce auth broker listening on port ${PORT}`);
});
