/*
 * Web backend for FRP server
 * Provides a simple Express API with token authentication that
 * exposes the current active clients and their port forwardings.
 */

const express = require('express');
const path = require('path');
const FRPServer = require('../src/server');
const ConfigLoader = require('../src/config');

// Load server configuration (same as CLI) – defaults to ./frps.yaml
const configFile = process.argv[2] || path.join(__dirname, '..', 'frps.yaml');
const rawConfig = ConfigLoader.loadYAML(configFile);
const serverConfig = ConfigLoader.validateServerConfig(rawConfig);

// Create FRP server instance and start it
const frpServer = new FRPServer(serverConfig);
frpServer.start();

// Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Simple token auth middleware – uses the token from server config if present
function authMiddleware(req, res, next) {
  // Accept token via Authorization header (Bearer) or ?token query param
  let providedToken = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.slice('Bearer '.length).trim();
  } else if (req.query && req.query.token) {
    providedToken = req.query.token.trim();
  }

  if (serverConfig.token) {
    if (!providedToken) {
      return res.status(401).json({ error: 'Missing Authorization token' });
    }
    if (providedToken !== serverConfig.token) {
      console.log(`Invalid token ${providedToken} ${serverConfig.token}`)
      return res.status(403).json({ error: `Invalid token ${providedToken} ${serverConfig.token}` });
    }
  }
  // No token required if not configured
  next();
}

// Serve static files without auth (so login page can be accessed)
app.use(express.static(path.join(__dirname, 'public')));

// Apply auth middleware only to API routes
app.use('/api', authMiddleware);

// Status endpoint – returns list of active clients and their forwardings
app.get('/api/status', (req, res) => {
  try {
    const status = frpServer.getStatus();
    res.json({ clients: status });
  } catch (err) {
    console.error('Failed to get status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Web UI listening on http://localhost:${PORT}`);
});
