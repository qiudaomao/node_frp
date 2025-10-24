const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

class Database {
  constructor(dbPath = './frp.db') {
    this.dbPath = dbPath;
    this.db = null;
  }

  // Initialize database connection and create tables
  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          console.error('Failed to connect to database:', err);
          reject(err);
          return;
        }
        console.log(`Connected to database at ${this.dbPath}`);
        this.createTables()
          .then(resolve)
          .catch(reject);
      });
    });
  }

  // Create database tables
  async createTables() {
    const sql = `
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        token TEXT NOT NULL UNIQUE,
        description TEXT,
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS port_forwards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        remote_port INTEGER NOT NULL UNIQUE,
        local_ip TEXT NOT NULL DEFAULT '127.0.0.1',
        local_port INTEGER NOT NULL,
        proxy_type TEXT NOT NULL DEFAULT 'tcp',
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
        UNIQUE(client_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_clients_token ON clients(token);
      CREATE INDEX IF NOT EXISTS idx_port_forwards_client ON port_forwards(client_id);
      CREATE INDEX IF NOT EXISTS idx_port_forwards_remote_port ON port_forwards(remote_port);

      CREATE TABLE IF NOT EXISTS traffic_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        port_forward_id INTEGER NOT NULL,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (port_forward_id) REFERENCES port_forwards(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_traffic_stats_port_forward ON traffic_stats(port_forward_id);
      CREATE INDEX IF NOT EXISTS idx_traffic_stats_timestamp ON traffic_stats(timestamp);
    `;

    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) {
          console.error('Failed to create tables:', err);
          reject(err);
        } else {
          console.log('Database tables initialized');
          resolve();
        }
      });
    });
  }

  // Generate a secure random token
  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  // Client operations
  async createClient(name, description = '') {
    const token = this.generateToken();
    const sql = 'INSERT INTO clients (name, token, description) VALUES (?, ?, ?)';

    return new Promise((resolve, reject) => {
      this.db.run(sql, [name, token, description], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ id: this.lastID, name, token, description });
        }
      });
    });
  }

  async getClient(id) {
    const sql = 'SELECT * FROM clients WHERE id = ?';

    return new Promise((resolve, reject) => {
      this.db.get(sql, [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async getClientByToken(token) {
    const sql = 'SELECT * FROM clients WHERE token = ? AND enabled = 1';

    return new Promise((resolve, reject) => {
      this.db.get(sql, [token], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async getAllClients() {
    const sql = 'SELECT * FROM clients ORDER BY created_at DESC';

    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async updateClient(id, updates) {
    const allowedFields = ['name', 'description', 'enabled'];
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) {
      return Promise.reject(new Error('No valid fields to update'));
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const sql = `UPDATE clients SET ${fields.join(', ')} WHERE id = ?`;

    return new Promise((resolve, reject) => {
      this.db.run(sql, values, function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
  }

  async deleteClient(id) {
    const sql = 'DELETE FROM clients WHERE id = ?';

    return new Promise((resolve, reject) => {
      this.db.run(sql, [id], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
  }

  // Port forward operations
  async createPortForward(clientId, name, remotePort, localIp, localPort, proxyType = 'tcp') {
    const sql = `
      INSERT INTO port_forwards (client_id, name, remote_port, local_ip, local_port, proxy_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    return new Promise((resolve, reject) => {
      this.db.run(sql, [clientId, name, remotePort, localIp, localPort, proxyType], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({
            id: this.lastID,
            client_id: clientId,
            name,
            remote_port: remotePort,
            local_ip: localIp,
            local_port: localPort,
            proxy_type: proxyType
          });
        }
      });
    });
  }

  async getPortForward(id) {
    const sql = 'SELECT * FROM port_forwards WHERE id = ?';

    return new Promise((resolve, reject) => {
      this.db.get(sql, [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async getPortForwardsByClient(clientId) {
    const sql = 'SELECT * FROM port_forwards WHERE client_id = ? AND enabled = 1 ORDER BY remote_port';

    return new Promise((resolve, reject) => {
      this.db.all(sql, [clientId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async getPortForwardsByToken(token) {
    const sql = `
      SELECT pf.*
      FROM port_forwards pf
      JOIN clients c ON pf.client_id = c.id
      WHERE c.token = ? AND c.enabled = 1 AND pf.enabled = 1
      ORDER BY pf.remote_port
    `;

    return new Promise((resolve, reject) => {
      this.db.all(sql, [token], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async getAllPortForwards() {
    const sql = `
      SELECT pf.*, c.name as client_name
      FROM port_forwards pf
      JOIN clients c ON pf.client_id = c.id
      ORDER BY pf.remote_port
    `;

    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async updatePortForward(id, updates) {
    const allowedFields = ['name', 'remote_port', 'local_ip', 'local_port', 'proxy_type', 'enabled'];
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) {
      return Promise.reject(new Error('No valid fields to update'));
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const sql = `UPDATE port_forwards SET ${fields.join(', ')} WHERE id = ?`;

    return new Promise((resolve, reject) => {
      this.db.run(sql, values, function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
  }

  async deletePortForward(id) {
    const sql = 'DELETE FROM port_forwards WHERE id = ?';

    return new Promise((resolve, reject) => {
      this.db.run(sql, [id], function(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      });
    });
  }

  // Check if remote port is available
  async isRemotePortAvailable(remotePort, excludeId = null) {
    let sql = 'SELECT COUNT(*) as count FROM port_forwards WHERE remote_port = ? AND enabled = 1';
    const params = [remotePort];

    if (excludeId) {
      sql += ' AND id != ?';
      params.push(excludeId);
    }

    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row.count === 0);
      });
    });
  }

  // Get statistics
  async getStatistics() {
    const sql = `
      SELECT
        (SELECT COUNT(*) FROM clients WHERE enabled = 1) as active_clients,
        (SELECT COUNT(*) FROM clients) as total_clients,
        (SELECT COUNT(*) FROM port_forwards WHERE enabled = 1) as active_forwards,
        (SELECT COUNT(*) FROM port_forwards) as total_forwards
    `;

    return new Promise((resolve, reject) => {
      this.db.get(sql, [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  // Traffic statistics methods
  async updatePortForwardTraffic(portForwardId, bytesIn, bytesOut) {
    const sql = `
      INSERT INTO traffic_stats (port_forward_id, bytes_in, bytes_out, timestamp)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `;

    return new Promise((resolve, reject) => {
      this.db.run(sql, [portForwardId, bytesIn, bytesOut], function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID });
      });
    });
  }

  async getPortForwardTraffic(portForwardId, since = null) {
    let sql = `
      SELECT
        SUM(bytes_in) as total_bytes_in,
        SUM(bytes_out) as total_bytes_out,
        SUM(bytes_in + bytes_out) as total_bytes,
        COUNT(*) as record_count,
        MAX(timestamp) as last_activity
      FROM traffic_stats
      WHERE port_forward_id = ?
    `;
    const params = [portForwardId];

    if (since) {
      sql += ' AND timestamp >= ?';
      params.push(since);
    }

    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || { total_bytes_in: 0, total_bytes_out: 0, total_bytes: 0, record_count: 0, last_activity: null });
      });
    });
  }

  async getAllPortForwardsTraffic() {
    const sql = `
      SELECT
        pf.id,
        pf.name,
        pf.remote_port,
        c.name as client_name,
        COALESCE(SUM(ts.bytes_in), 0) as total_bytes_in,
        COALESCE(SUM(ts.bytes_out), 0) as total_bytes_out,
        COALESCE(SUM(ts.bytes_in + ts.bytes_out), 0) as total_bytes,
        MAX(ts.timestamp) as last_activity
      FROM port_forwards pf
      LEFT JOIN clients c ON pf.client_id = c.id
      LEFT JOIN traffic_stats ts ON pf.id = ts.port_forward_id
      GROUP BY pf.id, pf.name, pf.remote_port, c.name
      ORDER BY total_bytes DESC
    `;

    return new Promise((resolve, reject) => {
      this.db.all(sql, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // Close database connection
  close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = Database;
