const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const FRPServer = require('../src/server');
const ConfigLoader = require('../src/config');
const Database = require('../src/database');

const app = express();

// Configuration
const PORT = process.env.WEB_PORT || 8080;
const DB_PATH = process.env.DB_PATH || './frp.db';
const SESSION_SECRET = process.env.SESSION_SECRET || 'frp-secret-change-me';

// Initialize database
const db = new Database(DB_PATH);

// Initialize FRP server for dynamic updates
let frpServer = null;

async function initializeFRPServer() {
  try {
    // Load server configuration (same as CLI) – defaults to ./frps.yaml
    const configFile = path.join(__dirname, '..', 'frps.yaml');
    let serverConfig;

    try {
      const rawConfig = ConfigLoader.loadYAML(configFile);
      serverConfig = ConfigLoader.validateServerConfig(rawConfig);
    } catch (err) {
      console.warn('Could not load frps.yaml, using defaults:', err.message);
      serverConfig = ConfigLoader.validateServerConfig({
        bindPort: 7000,
        databasePath: DB_PATH
      });
    }

    // Override database path to use the same one
    serverConfig.databasePath = DB_PATH;

    frpServer = new FRPServer(serverConfig);
    console.log('FRP server integration initialized for dynamic updates');
  } catch (err) {
    console.error('Failed to initialize FRP server for web UI:', err);
  }
}

// Initialize FRP server when database is ready
db.initialize().then(() => {
  initializeFRPServer();
}).catch(err => {
  console.error('Failed to initialize database:', err);
});

// Helper function to reload client port forwards
async function reloadClientPortForwards(clientId) {
  if (frpServer) {
    try {
      await frpServer.reloadClientPortForwards(clientId);
    } catch (err) {
      console.error('Failed to reload port forwards for client:', err);
    }
  }
}

const VALID_PROXY_TYPES = new Set(['tcp', 'udp', 'socks5']);
function normalizeProxyType(type) {
  const normalized = (type || 'tcp').toString().trim().toLowerCase();
  return VALID_PROXY_TYPES.has(normalized) ? normalized : 'tcp';
}

// Middleware
app.use(morgan('combined'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if using HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use('/static', express.static(path.join(__dirname, 'public')));

// Simple authentication middleware (you should replace with proper auth)
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    next();
  } else {
    res.redirect('/login');
  }
};

// Routes

// Login page
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { password } = req.body;

  // Simple password check (replace with proper authentication)
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';

  if (password === adminPassword) {
    req.session.authenticated = true;
    res.redirect('/');
  } else {
    res.render('login', { error: 'Invalid password' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Dashboard
app.get('/', requireAuth, async (req, res) => {
  try {
    const stats = await db.getStatistics();
    const clients = await db.getAllClients();
    const portForwards = await db.getAllPortForwards();

    res.render('dashboard', {
      stats,
      clients,
      portForwards
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Internal server error');
  }
});

// Clients management
app.get('/clients', requireAuth, async (req, res) => {
  try {
    const clients = await db.getAllClients();
    res.render('clients', { clients });
  } catch (err) {
    console.error('Error loading clients:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/clients/new', requireAuth, (req, res) => {
  res.render('client-form', { client: null, error: null });
});

app.post('/clients/new', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    const client = await db.createClient(name, description);
    res.redirect('/clients');
  } catch (err) {
    console.error('Error creating client:', err);
    res.render('client-form', {
      client: req.body,
      error: err.message
    });
  }
});

app.get('/clients/:id', requireAuth, async (req, res) => {
  try {
    const client = await db.getClient(req.params.id);
    if (!client) {
      return res.status(404).send('Client not found');
    }
    const portForwards = await db.getPortForwardsByClient(req.params.id);
    res.render('client-detail', { client, portForwards });
  } catch (err) {
    console.error('Error loading client:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/clients/:id/edit', requireAuth, async (req, res) => {
  try {
    const client = await db.getClient(req.params.id);
    if (!client) {
      return res.status(404).send('Client not found');
    }
    res.render('client-form', { client, error: null });
  } catch (err) {
    console.error('Error loading client:', err);
    res.status(500).send('Internal server error');
  }
});

app.post('/clients/:id/edit', requireAuth, async (req, res) => {
  try {
    const { name, description, enabled } = req.body;
    await db.updateClient(req.params.id, {
      name,
      description,
      enabled: enabled ? 1 : 0
    });
    res.redirect(`/clients/${req.params.id}`);
  } catch (err) {
    console.error('Error updating client:', err);
    const client = await db.getClient(req.params.id);
    res.render('client-form', {
      client: { ...client, ...req.body },
      error: err.message
    });
  }
});

// Port forwards management
app.get('/port-forwards', requireAuth, async (req, res) => {
  try {
    const portForwards = await db.getAllPortForwards();
    res.render('port-forwards', { portForwards });
  } catch (err) {
    console.error('Error loading port forwards:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/port-forwards/new', requireAuth, async (req, res) => {
  try {
    const clients = await db.getAllClients();
    res.render('port-forward-form', {
      portForward: null,
      clients,
      error: null
    });
  } catch (err) {
    console.error('Error loading clients:', err);
    res.status(500).send('Internal server error');
  }
});

app.post('/port-forwards/new', requireAuth, async (req, res) => {
  try {
    const { client_id, name, remote_port, local_ip, local_port, proxy_type, direction, remote_ip } = req.body;
    const normalizedProxyType = normalizeProxyType(proxy_type);

    // Check if remote port is available
    const available = await db.isRemotePortAvailable(remote_port);
    if (!available) {
      throw new Error(`Remote port ${remote_port} is already in use`);
    }

    await db.createPortForward(
      client_id,
      name,
      parseInt(remote_port || 0),
      local_ip || '127.0.0.1',
      parseInt(local_port || 0),
      normalizedProxyType,
      direction || 'forward',
      remote_ip || '127.0.0.1'
    );

    // Trigger dynamic reload for connected client
    await reloadClientPortForwards(parseInt(client_id));

    res.redirect('/port-forwards');
  } catch (err) {
    console.error('Error creating port forward:', err);
    const clients = await db.getAllClients();
    res.render('port-forward-form', {
      portForward: req.body,
      clients,
      error: err.message
    });
  }
});

app.get('/port-forwards/:id/edit', requireAuth, async (req, res) => {
  try {
    const portForward = await db.getPortForward(req.params.id);
    if (!portForward) {
      return res.status(404).send('Port forward not found');
    }
    const clients = await db.getAllClients();
    res.render('port-forward-form', {
      portForward,
      clients,
      error: null
    });
  } catch (err) {
    console.error('Error loading port forward:', err);
    res.status(500).send('Internal server error');
  }
});

app.post('/port-forwards/:id/edit', requireAuth, async (req, res) => {
  try {
    const { name, remote_port, local_ip, local_port, proxy_type, enabled, direction, remote_ip } = req.body;
    const normalizedProxyType = normalizeProxyType(proxy_type);

    // Check if remote port is available (excluding current record)
    const available = await db.isRemotePortAvailable(remote_port, req.params.id);
    if (!available) {
      throw new Error(`Remote port ${remote_port} is already in use`);
    }

    // Get the current port forward to get the client_id
    const portForward = await db.getPortForward(req.params.id);

    await db.updatePortForward(req.params.id, {
      name,
      remote_port: remote_port ? parseInt(remote_port) : 0,
      local_ip: local_ip || '127.0.0.1',
      local_port: local_port ? parseInt(local_port) : 0,
      proxy_type: normalizedProxyType,
      enabled: enabled ? 1 : 0,
      direction: direction || 'forward',
      remote_ip: remote_ip || '127.0.0.1'
    });

    // Trigger dynamic reload for connected client
    if (portForward) {
      await reloadClientPortForwards(portForward.client_id);
    }

    res.redirect('/port-forwards');
  } catch (err) {
    console.error('Error updating port forward:', err);
    const portForward = await db.getPortForward(req.params.id);
    const clients = await db.getAllClients();
    res.render('port-forward-form', {
      portForward: { ...portForward, ...req.body },
      clients,
      error: err.message
    });
  }
});

// API endpoints
app.use('/api', apiLimiter);

app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const clients = await db.getAllClients();
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const client = await db.getClient(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    const client = await db.createClient(name, description);
    res.status(201).json(client);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    await db.updateClient(req.params.id, req.body);
    const client = await db.getClient(req.params.id);
    res.json(client);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    await db.deleteClient(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/port-forwards', requireAuth, async (req, res) => {
  try {
    const portForwards = await db.getAllPortForwards();
    res.json(portForwards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/port-forwards/:id', requireAuth, async (req, res) => {
  try {
    const portForward = await db.getPortForward(req.params.id);
    if (!portForward) {
      return res.status(404).json({ error: 'Port forward not found' });
    }
    res.json(portForward);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/port-forwards', requireAuth, async (req, res) => {
  try {
    const { client_id, name, remote_port, local_ip, local_port, proxy_type, direction, remote_ip } = req.body;
    const normalizedProxyType = normalizeProxyType(proxy_type);

    const available = await db.isRemotePortAvailable(remote_port);
    if (!available) {
      return res.status(400).json({ error: `Remote port ${remote_port} is already in use` });
    }

    const portForward = await db.createPortForward(
      client_id,
      name,
      parseInt(remote_port || 0),
      local_ip || '127.0.0.1',
      parseInt(local_port || 0),
      normalizedProxyType,
      direction || 'forward',
      remote_ip || '127.0.0.1'
    );

    // Trigger dynamic reload for connected client
    await reloadClientPortForwards(parseInt(client_id));

    res.status(201).json(portForward);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/port-forwards/:id', requireAuth, async (req, res) => {
  try {
    if (req.body.remote_port) {
      const available = await db.isRemotePortAvailable(req.body.remote_port, req.params.id);
      if (!available) {
        return res.status(400).json({ error: `Remote port ${req.body.remote_port} is already in use` });
      }
    }

    // Get the current port forward to get the client_id
    const currentPortForward = await db.getPortForward(req.params.id);

    const updatePayload = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(updatePayload, 'proxy_type')) {
      updatePayload.proxy_type = normalizeProxyType(updatePayload.proxy_type);
    }
    await db.updatePortForward(req.params.id, updatePayload);
    const portForward = await db.getPortForward(req.params.id);

    // Trigger dynamic reload for connected client
    if (currentPortForward) {
      await reloadClientPortForwards(currentPortForward.client_id);
    }

    res.json(portForward);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/port-forwards/:id', requireAuth, async (req, res) => {
  try {
    // Get the current port forward to get the client_id
    const portForward = await db.getPortForward(req.params.id);

    await db.deletePortForward(req.params.id);

    // Trigger dynamic reload for connected client
    if (portForward) {
      await reloadClientPortForwards(portForward.client_id);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Toggle endpoint for enable/disable from UI
app.put('/api/port-forwards/:id/toggle', requireAuth, async (req, res) => {
  try {
    const current = await db.getPortForward(req.params.id);
    if (!current) return res.status(404).json({ error: 'Not found' });
    const updatedEnabled = current.enabled ? 0 : 1;
    await db.updatePortForward(req.params.id, { enabled: updatedEnabled });
    await reloadClientPortForwards(current.client_id);
    const refreshed = await db.getPortForward(req.params.id);
    res.json(refreshed);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/statistics', requireAuth, async (req, res) => {
  try {
    const stats = await db.getStatistics();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
async function start() {
  try {
    await db.initialize();
    console.log('Database initialized');

    app.listen(PORT, () => {
      console.log(`Web UI available at http://localhost:${PORT}`);
      console.log(`Default password: ${process.env.ADMIN_PASSWORD || 'admin'}`);
    });
  } catch (err) {
    console.error('Failed to start web server:', err);
    process.exit(1);
  }
}

start();

module.exports = app;
