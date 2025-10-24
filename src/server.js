const net = require("net");
const Database = require('./database');
const WebUIServer = require('./webui');

class FRPServer {
  constructor(config) {
    this.config = config;
    this.controlServer = null;
    this.webUI = null;
    this.proxyServers = new Map();
    this.clients = new Map(); // Maps socket -> [ports]
    this.clientSockets = new Map(); // Maps clientId -> socket
    this.pendingConnections = new Map();
    this.database = new Database(config.databasePath || './frp.db');

    // Real-time traffic tracking
    this.trafficCounters = new Map(); // portForwardId -> { bytesIn, bytesOut }
    this.trafficFlushInterval = null;
  }

  async start() {
    const port = this.config.bindPort || 7000;

    // Initialize database
    try {
      await this.database.initialize();
      console.log('Database initialized successfully');
    } catch (err) {
      console.error('Failed to initialize database:', err);
      process.exit(1);
    }

    // Start FRP control server
    this.controlServer = net.createServer((socket) => {
      this.handleControlConnection(socket);
    });

    this.controlServer.listen(port, () => {
      console.log(`FRP Server started on port ${port}`);
    });

    this.controlServer.on("error", (err) => {
      console.error("Server error:", err);
    });

    // Start Web UI if enabled
    if (this.config.webUI && this.config.webUI.enabled) {
      try {
        this.webUI = new WebUIServer(this.config, this.database, this);
        await this.webUI.start();
      } catch (err) {
        console.error('Failed to start Web UI:', err);
        console.log('FRP Server will continue without Web UI');
      }
    } else {
      console.log('Web UI is disabled');
    }

    // Start periodic traffic flushing (configurable interval)
    const flushIntervalMs = (this.config.trafficFlushInterval || 30) * 1000;
    this.startTrafficFlushing(flushIntervalMs);
  }

  handleControlConnection(socket) {
    console.log("New connection from:", socket.remoteAddress);

    let buffer = "";
    let isControlConnection = false;
    let handshakeComplete = false;
    let authenticated = false;
    let heartbeatTimer = null;

    // Enable TCP keepalive to detect dead connections
    socket.setKeepAlive(true, 20000); // 20 seconds
    socket.setTimeout(0); // No timeout on socket itself, we'll use heartbeat

    // Helper to start heartbeat timeout
    const startHeartbeatTimeout = () => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
      }
      // Expect heartbeat every 20 seconds, timeout after 40 seconds
      heartbeatTimer = setTimeout(() => {
        console.log("Client heartbeat timeout, closing connection");
        this.cleanupClient(socket);
        socket.destroy();
      }, 40000); // 40 seconds
    };

    // Helper to cleanup heartbeat timer
    const cleanupHeartbeatTimer = () => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const onData = async (data) => {
      buffer += data.toString();

      // Check for handshake in first message
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1 && !handshakeComplete) {
        const message = buffer.substring(0, newlineIndex);

        try {
          const msg = JSON.parse(message);

          // Check if this is a data connection or data connection
          if (msg.type === "data_connection") {
            // This is a data connection, not a control connection
            handshakeComplete = true;
            socket.removeListener("data", onData);

            // Emit event for data connection with buffered data
            this.handleIncomingDataConnection(
              socket,
              msg,
              buffer.substring(newlineIndex + 1),
            );
            return;
          } else if (msg.type === "control_handshake") {
            // This is a control connection - verify authentication
            isControlConnection = true;

            // Check token against database
            if (msg.token) {
              try {
                const client = await this.database.getClientByToken(msg.token);
                if (client) {
                  authenticated = true;
                  console.log(`Client [${client.name}] authenticated successfully`);
                  // Store client info on socket for later use
                  socket.clientId = client.id;
                  socket.clientName = client.name;
                  // Track socket by client ID for dynamic updates
                  this.clientSockets.set(client.id, socket);
                } else {
                  console.error("Authentication failed: Invalid token from", socket.remoteAddress);
                  socket.write(
                    JSON.stringify({
                      type: "auth_response",
                      success: false,
                      error: "Invalid authentication token",
                    }) + "\n",
                  );
                  socket.destroy();
                  return;
                }
              } catch (err) {
                console.error("Database error during authentication:", err);
                socket.write(
                  JSON.stringify({
                    type: "auth_response",
                    success: false,
                    error: "Authentication failed due to server error",
                  }) + "\n",
                );
                socket.destroy();
                return;
              }
            } else {
              console.error("Authentication failed: No token provided from", socket.remoteAddress);
              socket.write(
                JSON.stringify({
                  type: "auth_response",
                  success: false,
                  error: "Authentication token is required",
                }) + "\n",
              );
              socket.destroy();
              return;
            }

            handshakeComplete = true;

            // Get port forwards for this client from database
            let portForwards = [];
            try {
              const forwards = await this.database.getPortForwardsByClient(socket.clientId);
              portForwards = forwards.map(f => ({
                name: f.name,
                remotePort: f.remote_port,
                localIp: f.local_ip,
                localPort: f.local_port,
                proxyType: f.proxy_type
              }));
            } catch (err) {
              console.error("Failed to load port forwards:", err);
            }

            // Send auth success response with port forward assignments
            socket.write(
              JSON.stringify({
                type: "auth_response",
                success: true,
                portForwards: portForwards
              }) + "\n",
            );

            // Start heartbeat monitoring after successful authentication
            startHeartbeatTimeout();

            buffer = buffer.substring(newlineIndex + 1);

            // Continue processing any remaining messages
            this.processControlMessages(socket, buffer, startHeartbeatTimeout);

            // Create proxy servers for this client automatically
            await this.createClientProxies(socket);

            // Switch to control message handler
            socket.removeListener("data", onData);
            socket.on("data", (data) => {
              this.processControlMessages(socket, data.toString(), startHeartbeatTimeout);
            });
          } else {
            // Unexpected message type during handshake
            console.error(
              "Invalid handshake: unexpected message type",
              msg.type,
            );
            socket.destroy();
          }
        } catch (err) {
          // Invalid JSON, close connection
          console.error("Invalid handshake:", err.message);
          socket.destroy();
        }
      }
    };

    socket.on("data", onData);

    socket.on("end", () => {
      cleanupHeartbeatTimer();
      if (isControlConnection) {
        console.log("Client disconnected");
        this.cleanupClient(socket);
      }
    });

    socket.on("error", (err) => {
      cleanupHeartbeatTimer();
      if (isControlConnection) {
        console.error("Socket error:", err);
        this.cleanupClient(socket);
      }
    });

    socket.on("close", (hadError) => {
      cleanupHeartbeatTimer();
      if (isControlConnection) {
        console.log(`Socket closed ${hadError ? 'with error' : 'cleanly'}`);
        this.cleanupClient(socket);
      }
    });
  }

  processControlMessages(socket, dataStr, startHeartbeatTimeout) {
    if (!socket.msgBuffer) {
      socket.msgBuffer = "";
    }

    socket.msgBuffer += dataStr;

    let newlineIndex;
    while ((newlineIndex = socket.msgBuffer.indexOf("\n")) !== -1) {
      const message = socket.msgBuffer.substring(0, newlineIndex);
      socket.msgBuffer = socket.msgBuffer.substring(newlineIndex + 1);

      try {
        const msg = JSON.parse(message);
        this.handleMessage(socket, msg, startHeartbeatTimeout);
      } catch (err) {
        console.error("Failed to parse message:", err);
      }
    }
  }

  handleIncomingDataConnection(socket, msg, remainingBuffer) {
    const { connectionId } = msg;

    // Find pending connection
    const pendingConn = this.pendingConnections.get(connectionId);
    if (pendingConn) {
      console.log(`Data connection established for ${connectionId}`);

      this.pendingConnections.delete(connectionId);

      // Pipe any remaining buffered data
      if (remainingBuffer.length > 0) {
        pendingConn.clientSocket.write(remainingBuffer);
      }

      // Track traffic for this port forward
      const portForwardId = pendingConn.portForwardId;
      const self = this; // Capture 'this' reference

      // Wrap socket to track traffic
      const originalWrite = socket.write.bind(socket);
      socket.write = function(data) {
        if (data && data.length > 0) {
          // Update real-time counter
          self.incrementTraffic(portForwardId, 0, data.length);
        }
        return originalWrite(data);
      };

      const originalClientWrite = pendingConn.clientSocket.write.bind(pendingConn.clientSocket);
      pendingConn.clientSocket.write = function(data) {
        if (data && data.length > 0) {
          // Update real-time counter
          self.incrementTraffic(portForwardId, data.length, 0);
        }
        return originalClientWrite(data);
      };

      // Pipe the connections together
      pendingConn.clientSocket.pipe(socket);
      socket.pipe(pendingConn.clientSocket);

      // Note: Traffic is now tracked in real-time and flushed periodically
      // No need to track locally anymore

      pendingConn.clientSocket.on("error", () => {
        socket.destroy();
      });

      socket.on("error", () => {
        pendingConn.clientSocket.destroy();
      });

      pendingConn.clientSocket.on("end", () => {
        socket.end();
      });

      socket.on("end", () => {
        pendingConn.clientSocket.end();
      });
    } else {
      console.error(`No pending connection found for ${connectionId}`);
      socket.destroy();
    }
  }

  handleMessage(socket, msg, startHeartbeatTimeout) {
    switch (msg.type) {
      case "register":
        // No longer needed - proxies are created automatically from database
        socket.write(
          JSON.stringify({
            type: "register_response",
            success: false,
            error: "Port forwards are now managed server-side via database"
          }) + "\n"
        );
        break;
      case "heartbeat":
        // Reset heartbeat timeout on each heartbeat
        if (startHeartbeatTimeout) {
          startHeartbeatTimeout();
        }
        socket.write(JSON.stringify({ type: "heartbeat_ack" }) + "\n");
        break;
      default:
        console.log("Unknown message type:", msg.type);
    }
  }

  async createClientProxies(socket) {
    if (!socket.clientId) {
      console.error('Cannot create proxies: client ID not set');
      return;
    }

    try {
      const portForwards = await this.database.getPortForwardsByClient(socket.clientId);

      for (const forward of portForwards) {
        await this.createProxyServer(socket, {
          name: forward.name,
          remotePort: forward.remote_port,
          proxyType: forward.proxy_type,
          portForwardId: forward.id
        });
      }
    } catch (err) {
      console.error('Failed to create client proxies:', err);
    }
  }

  async createProxyServer(controlSocket, { name, remotePort, proxyType, portForwardId }) {
    // Check if port is already in use
    if (this.proxyServers.has(remotePort)) {
      console.error(`Port ${remotePort} already in use`);
      return;
    }

    // Create proxy server for this remote port
    const proxyServer = net.createServer((clientSocket) => {
      this.handleProxyConnection(controlSocket, clientSocket, name, portForwardId);
    });

    return new Promise((resolve, reject) => {
      proxyServer.listen(remotePort, () => {
        console.log(`Proxy [${name}] listening on port ${remotePort}`);

        this.proxyServers.set(remotePort, {
          server: proxyServer,
          name: name,
          controlSocket: controlSocket,
          portForwardId: portForwardId,
        });

        if (!this.clients.has(controlSocket)) {
          this.clients.set(controlSocket, []);
        }
        this.clients.get(controlSocket).push(remotePort);

        resolve();
      });

      proxyServer.on("error", (err) => {
        console.error(`Proxy [${name}] error:`, err);
        reject(err);
      });
    });
  }

  handleProxyConnection(controlSocket, clientSocket, proxyName, portForwardId) {
    const connectionId = Math.random().toString(36).substring(7);

    console.log(`New connection to proxy [${proxyName}], id: ${connectionId}`);

    // Store pending connection
    this.pendingConnections.set(connectionId, {
      clientSocket: clientSocket,
      proxyName: proxyName,
      portForwardId: portForwardId,
    });

    // Request client to establish a data connection
    controlSocket.write(
      JSON.stringify({
        type: "new_connection",
        proxyName: proxyName,
        connectionId: connectionId,
      }) + "\n",
    );

    // Cleanup on timeout
    setTimeout(() => {
      if (this.pendingConnections.has(connectionId)) {
        console.log(`Connection ${connectionId} timed out`);
        this.pendingConnections.delete(connectionId);
        clientSocket.destroy();
      }
    }, 10000);
  }

  cleanupClient(socket) {
    const ports = this.clients.get(socket);
    if (ports) {
      console.log(`Cleaning up client at ${socket.remoteAddress || 'unknown'}, closing ${ports.length} proxy servers`);
      ports.forEach((port) => {
        const proxy = this.proxyServers.get(port);
        if (proxy) {
          try {
            proxy.server.close();
            console.log(`Closed proxy [${proxy.name}] on port ${port}`);
          } catch (err) {
            console.error(`Error closing proxy on port ${port}:`, err);
          }
          this.proxyServers.delete(port);
        }
      });
      this.clients.delete(socket);
    }

    // Remove from clientSockets tracking
    if (socket.clientId) {
      this.clientSockets.delete(socket.clientId);
    }

    // Clean up any pending connections for this client
    for (const [connectionId, pending] of this.pendingConnections.entries()) {
      if (pending.clientSocket && pending.clientSocket.destroyed === false) {
        pending.clientSocket.destroy();
      }
      this.pendingConnections.delete(connectionId);
    }
  }

  // Get list of connected client IDs
  getConnectedClientIds() {
    const connectedIds = [];
    for (const [clientId, socket] of this.clientSockets.entries()) {
      if (socket && !socket.destroyed) {
        connectedIds.push(clientId);
      }
    }
    return connectedIds;
  }

  // Get real-time traffic data
  getTrafficCounters() {
    const traffic = {};
    for (const [portForwardId, counters] of this.trafficCounters.entries()) {
      traffic[portForwardId] = { ...counters };
    }
    return traffic;
  }

  // Increment traffic counter for a port forward
  incrementTraffic(portForwardId, bytesIn, bytesOut) {
    if (!this.trafficCounters.has(portForwardId)) {
      this.trafficCounters.set(portForwardId, { bytesIn: 0, bytesOut: 0 });
    }
    const counter = this.trafficCounters.get(portForwardId);
    counter.bytesIn += bytesIn;
    counter.bytesOut += bytesOut;
  }

  // Flush traffic counters to database periodically
  async flushTrafficCounters() {
    const countersToFlush = new Map(this.trafficCounters);

    // Reset counters
    this.trafficCounters.clear();

    // Flush to database
    for (const [portForwardId, counters] of countersToFlush.entries()) {
      if (counters.bytesIn > 0 || counters.bytesOut > 0) {
        try {
          await this.database.updatePortForwardTraffic(portForwardId, counters.bytesIn, counters.bytesOut);
        } catch (err) {
          console.error(`Failed to flush traffic for port forward ${portForwardId}:`, err);
        }
      }
    }
  }

  // Start periodic traffic flushing
  startTrafficFlushing(intervalMs = 30000) {
    if (this.trafficFlushInterval) {
      clearInterval(this.trafficFlushInterval);
    }

    this.trafficFlushInterval = setInterval(async () => {
      await this.flushTrafficCounters();
    }, intervalMs);

    console.log(`Traffic flushing started (interval: ${intervalMs}ms)`);
  }

  stop() {
    // Stop periodic traffic flushing
    if (this.trafficFlushInterval) {
      clearInterval(this.trafficFlushInterval);
      this.trafficFlushInterval = null;
    }

    // Flush remaining traffic before stopping
    this.flushTrafficCounters().catch(err => {
      console.error('Failed to flush traffic on shutdown:', err);
    });

    if (this.controlServer) {
      this.controlServer.close();
    }
    this.proxyServers.forEach((proxy) => {
      proxy.server.close();
    });
    if (this.webUI) {
      this.webUI.stop();
    }
  }

  // Reload port forwards for a specific client
  async reloadClientPortForwards(clientId) {
    const socket = this.clientSockets.get(clientId);
    if (!socket || socket.destroyed) {
      console.log(`Client ${clientId} not connected, skipping reload`);
      return;
    }

    try {
      console.log(`Reloading port forwards for client ${socket.clientName} (ID: ${clientId})`);

      // Get current port forwards from database
      const newForwards = await this.database.getPortForwardsByClient(clientId);
      const currentPorts = this.clients.get(socket) || [];

      // Find ports to remove (no longer in database)
      const newPortSet = new Set(newForwards.map(f => f.remote_port));
      const portsToRemove = currentPorts.filter(port => !newPortSet.has(port));

      // Close removed proxy servers
      for (const port of portsToRemove) {
        const proxy = this.proxyServers.get(port);
        if (proxy && proxy.controlSocket === socket) {
          try {
            proxy.server.close();
            this.proxyServers.delete(port);
            console.log(`Removed proxy [${proxy.name}] on port ${port}`);
          } catch (err) {
            console.error(`Error closing proxy on port ${port}:`, err);
          }
        }
      }

      // Update the client's port list
      const remainingPorts = currentPorts.filter(port => newPortSet.has(port));
      this.clients.set(socket, remainingPorts);

      // Create new proxy servers
      for (const forward of newForwards) {
        if (!this.proxyServers.has(forward.remote_port)) {
          try {
            await this.createProxyServer(socket, {
              name: forward.name,
              remotePort: forward.remote_port,
              proxyType: forward.proxy_type,
              portForwardId: forward.id
            });
          } catch (err) {
            console.error(`Failed to create proxy [${forward.name}]:`, err);
          }
        }
      }

      // Send updated port forward list to client
      const portForwards = newForwards.map(f => ({
        name: f.name,
        remotePort: f.remote_port,
        localIp: f.local_ip,
        localPort: f.local_port,
        proxyType: f.proxy_type
      }));

      socket.write(
        JSON.stringify({
          type: "config_update",
          portForwards: portForwards
        }) + "\n"
      );

      console.log(`Successfully reloaded ${newForwards.length} port forwards for client ${socket.clientName}`);
    } catch (err) {
      console.error(`Error reloading port forwards for client ${clientId}:`, err);
    }
  }

  // Get reference to server instance for web UI integration
  getDatabase() {
    return this.database;
  }

  // Return status of active clients and their forwardings
  getStatus() {
    const status = [];
    for (const [socket, ports] of this.clients.entries()) {
      const clientInfo = {
        address: socket.remoteAddress,
        ports: [],
      };
      for (const port of ports) {
        const proxy = this.proxyServers.get(port);
        if (proxy) {
          clientInfo.ports.push({ remotePort: port, name: proxy.name });
        }
      }
      status.push(clientInfo);
    }
    return status;
  }
}

module.exports = FRPServer;
