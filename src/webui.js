const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');

class WebUIServer {
  constructor(config, database, frpServer) {
    this.config = config;
    this.database = database;
    this.frpServer = frpServer;
    this.app = express();
    this.httpServer = null;

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Suppress HTTP request logs
    // this.app.use(morgan('combined'));
    this.app.use(bodyParser.json());
    this.app.use(bodyParser.urlencoded({ extended: true }));
    this.app.use(cookieParser());

    // Generate a random session secret on startup
    const crypto = require('crypto');
    const sessionSecret = crypto.randomBytes(32).toString('hex');

    this.app.use(session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    }));

    // Rate limiting
    const apiLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100
    });

    // View engine setup
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(__dirname, '..', 'web', 'views'));

    // Static files
    this.app.use('/static', express.static(path.join(__dirname, '..', 'web', 'public')));

    // Apply rate limiting to API routes
    this.app.use('/api', apiLimiter);
  }

  requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
      next();
    } else {
      res.redirect('/login');
    }
  }

  async reloadClientPortForwards(clientId) {
    if (this.frpServer) {
      try {
        await this.frpServer.reloadClientPortForwards(clientId);
      } catch (err) {
        console.error('Failed to reload port forwards for client:', err);
      }
    }
  }

  setupRoutes() {
    const requireAuth = this.requireAuth.bind(this);
    const db = this.database;
    const reloadClientPortForwards = this.reloadClientPortForwards.bind(this);

    // Login routes
    this.app.get('/login', (req, res) => {
      res.render('login', { error: null });
    });

    this.app.post('/login', (req, res) => {
      const { username, password } = req.body;
      if (username === this.config.webUI.username && password === this.config.webUI.password) {
        req.session.authenticated = true;
        req.session.username = username;
        res.redirect('/');
      } else {
        res.render('login', { error: 'Invalid username or password' });
      }
    });

    this.app.get('/logout', (req, res) => {
      req.session.destroy();
      res.redirect('/login');
    });

    // Dashboard
    this.app.get('/', requireAuth, async (req, res) => {
      try {
        const stats = await db.getStatistics();
        const clients = await db.getAllClients();
        const portForwards = await db.getAllPortForwards();
        const connectedClientIds = this.frpServer ? this.frpServer.getConnectedClientIds() : [];

        // Add connection status to clients and port forwards
        const clientsWithStatus = clients.map(c => ({
          ...c,
          connected: connectedClientIds.includes(c.id)
        }));

        const portForwardsWithStatus = portForwards.map(pf => ({
          ...pf,
          client_connected: connectedClientIds.includes(pf.client_id),
          active: pf.enabled && connectedClientIds.includes(pf.client_id)
        }));

        res.render('dashboard', { stats, clients: clientsWithStatus, portForwards: portForwardsWithStatus });
      } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).send('Internal server error');
      }
    });

    // Clients management
    this.app.get('/clients', requireAuth, async (req, res) => {
      try {
        const clients = await db.getAllClients();
        const connectedClientIds = this.frpServer ? this.frpServer.getConnectedClientIds() : [];

        // Add connection status to each client
        const clientsWithStatus = clients.map(c => ({
          ...c,
          connected: connectedClientIds.includes(c.id)
        }));

        res.render('clients', { clients: clientsWithStatus });
      } catch (err) {
        console.error('Error loading clients:', err);
        res.status(500).send('Internal server error');
      }
    });

    this.app.get('/clients/new', requireAuth, (req, res) => {
      res.render('client-form', { client: null, error: null });
    });

    this.app.post('/clients/new', requireAuth, async (req, res) => {
      try {
        const { name, description } = req.body;
        await db.createClient(name, description);
        res.redirect('/clients');
      } catch (err) {
        console.error('Error creating client:', err);
        res.render('client-form', { client: req.body, error: err.message });
      }
    });

    this.app.get('/clients/:id', requireAuth, async (req, res) => {
      try {
        const client = await db.getClient(req.params.id);
        if (!client) return res.status(404).send('Client not found');
        const portForwards = await db.getPortForwardsByClient(req.params.id);
        res.render('client-detail', { client, portForwards });
      } catch (err) {
        console.error('Error loading client:', err);
        res.status(500).send('Internal server error');
      }
    });

    this.app.get('/clients/:id/edit', requireAuth, async (req, res) => {
      try {
        const client = await db.getClient(req.params.id);
        if (!client) return res.status(404).send('Client not found');
        res.render('client-form', { client, error: null });
      } catch (err) {
        console.error('Error loading client:', err);
        res.status(500).send('Internal server error');
      }
    });

    this.app.post('/clients/:id/edit', requireAuth, async (req, res) => {
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
    this.app.get('/port-forwards', requireAuth, async (req, res) => {
      try {
        const portForwards = await db.getAllPortForwards();
        const connectedClientIds = this.frpServer ? this.frpServer.getConnectedClientIds() : [];

        // Add connection status to each port forward
        const portForwardsWithStatus = portForwards.map(pf => ({
          ...pf,
          client_connected: connectedClientIds.includes(pf.client_id),
          active: pf.enabled && connectedClientIds.includes(pf.client_id)
        }));

        res.render('port-forwards', { portForwards: portForwardsWithStatus });
      } catch (err) {
        console.error('Error loading port forwards:', err);
        res.status(500).send('Internal server error');
      }
    });

    this.app.get('/port-forwards/new', requireAuth, async (req, res) => {
      try {
        const clients = await db.getAllClients();
        res.render('port-forward-form', { portForward: null, clients, error: null });
      } catch (err) {
        console.error('Error loading clients:', err);
        res.status(500).send('Internal server error');
      }
    });

    this.app.post('/port-forwards/new', requireAuth, async (req, res) => {
      try {
        const { client_id, name, remote_port, local_ip, local_port, proxy_type } = req.body;
        const available = await db.isRemotePortAvailable(remote_port);
        if (!available) {
          throw new Error(`Remote port ${remote_port} is already in use`);
        }
        await db.createPortForward(
          client_id,
          name,
          parseInt(remote_port),
          local_ip || '127.0.0.1',
          parseInt(local_port),
          proxy_type || 'tcp'
        );
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

    this.app.get('/port-forwards/:id/edit', requireAuth, async (req, res) => {
      try {
        const portForward = await db.getPortForward(req.params.id);
        if (!portForward) return res.status(404).send('Port forward not found');
        const clients = await db.getAllClients();
        res.render('port-forward-form', { portForward, clients, error: null });
      } catch (err) {
        console.error('Error loading port forward:', err);
        res.status(500).send('Internal server error');
      }
    });

    this.app.post('/port-forwards/:id/edit', requireAuth, async (req, res) => {
      try {
        const { name, remote_port, local_ip, local_port, proxy_type, enabled } = req.body;
        const available = await db.isRemotePortAvailable(remote_port, req.params.id);
        if (!available) {
          throw new Error(`Remote port ${remote_port} is already in use`);
        }
        const portForward = await db.getPortForward(req.params.id);
        await db.updatePortForward(req.params.id, {
          name,
          remote_port: parseInt(remote_port),
          local_ip: local_ip || '127.0.0.1',
          local_port: parseInt(local_port),
          proxy_type: proxy_type || 'tcp',
          enabled: enabled ? 1 : 0
        });
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
    this.app.get('/api/clients', requireAuth, async (req, res) => {
      try {
        const clients = await db.getAllClients();
        res.json(clients);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/clients/:id', requireAuth, async (req, res) => {
      try {
        const client = await db.getClient(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found' });
        res.json(client);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/clients', requireAuth, async (req, res) => {
      try {
        const { name, description } = req.body;
        const client = await db.createClient(name, description);
        res.status(201).json(client);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.put('/api/clients/:id', requireAuth, async (req, res) => {
      try {
        await db.updateClient(req.params.id, req.body);
        const client = await db.getClient(req.params.id);
        res.json(client);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.delete('/api/clients/:id', requireAuth, async (req, res) => {
      try {
        await db.deleteClient(req.params.id);
        res.json({ success: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.get('/api/port-forwards', requireAuth, async (req, res) => {
      try {
        const portForwards = await db.getAllPortForwards();
        const connectedClientIds = this.frpServer ? this.frpServer.getConnectedClientIds() : [];

        // Add connection status to each port forward
        const portForwardsWithStatus = portForwards.map(pf => ({
          ...pf,
          client_connected: connectedClientIds.includes(pf.client_id),
          active: pf.enabled && connectedClientIds.includes(pf.client_id)
        }));

        res.json(portForwardsWithStatus);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/port-forwards/:id', requireAuth, async (req, res) => {
      try {
        const portForward = await db.getPortForward(req.params.id);
        if (!portForward) return res.status(404).json({ error: 'Port forward not found' });
        res.json(portForward);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/port-forwards', requireAuth, async (req, res) => {
      try {
        const { client_id, name, remote_port, local_ip, local_port, proxy_type } = req.body;
        const available = await db.isRemotePortAvailable(remote_port);
        if (!available) {
          return res.status(400).json({ error: `Remote port ${remote_port} is already in use` });
        }
        const portForward = await db.createPortForward(
          client_id,
          name,
          parseInt(remote_port),
          local_ip || '127.0.0.1',
          parseInt(local_port),
          proxy_type || 'tcp'
        );
        await reloadClientPortForwards(parseInt(client_id));
        res.status(201).json(portForward);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.put('/api/port-forwards/:id', requireAuth, async (req, res) => {
      try {
        if (req.body.remote_port) {
          const available = await db.isRemotePortAvailable(req.body.remote_port, req.params.id);
          if (!available) {
            return res.status(400).json({ error: `Remote port ${req.body.remote_port} is already in use` });
          }
        }
        const currentPortForward = await db.getPortForward(req.params.id);
        await db.updatePortForward(req.params.id, req.body);
        const portForward = await db.getPortForward(req.params.id);
        if (currentPortForward) {
          await reloadClientPortForwards(currentPortForward.client_id);
        }
        res.json(portForward);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.put('/api/port-forwards/:id/toggle', requireAuth, async (req, res) => {
      try {
        const portForward = await db.getPortForward(req.params.id);
        if (!portForward) return res.status(404).json({ error: 'Port forward not found' });

        // Toggle the enabled status
        const newStatus = portForward.enabled ? 0 : 1;
        await db.updatePortForward(req.params.id, { enabled: newStatus });

        // Reload client configuration if client is connected
        if (portForward) {
          await reloadClientPortForwards(portForward.client_id);
        }

        const updatedPortForward = await db.getPortForward(req.params.id);
        res.json(updatedPortForward);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.delete('/api/port-forwards/:id', requireAuth, async (req, res) => {
      try {
        const portForward = await db.getPortForward(req.params.id);
        await db.deletePortForward(req.params.id);
        if (portForward) {
          await reloadClientPortForwards(portForward.client_id);
        }
        res.json({ success: true });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.get('/api/statistics', requireAuth, async (req, res) => {
      try {
        const stats = await db.getStatistics();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  async start() {
    return new Promise((resolve, reject) => {
      const port = this.config.webUI.port;
      this.httpServer = this.app.listen(port, () => {
        console.log(`Web UI available at http://localhost:${port}`);
        console.log(`Login credentials - Username: ${this.config.webUI.username}, Password: ${this.config.webUI.password}`);
        resolve();
      });

      this.httpServer.on('error', (err) => {
        console.error('Web UI server error:', err);
        reject(err);
      });
    });
  }

  stop() {
    if (this.httpServer) {
      this.httpServer.close();
      console.log('Web UI server stopped');
    }
  }
}

module.exports = WebUIServer;
