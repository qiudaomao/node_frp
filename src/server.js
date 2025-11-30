const net = require("net");

function genConnectionId() {
  // Low-collision ID: time + random segment
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
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
      socket.setNoDelay(true);
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
                proxyType: f.proxy_type,
                direction: f.direction,
                remoteIp: f.remote_ip
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

      const portForwardId = pendingConn.portForwardId;
      const self = this; // Capture 'this' reference

      // Clear any pending timeout for this connection
      if (pendingConn.timer) {
        try { clearTimeout(pendingConn.timer); } catch {}
        pendingConn.timer = null;
      }

      // Two modes:
      // 1) forward mode: pendingConn.clientSocket is a socket from external client to server proxy
      // 2) reverse mode: pendingConn.targetSocket is a socket from server to target on server network
      if (pendingConn.clientSocket) {
        // Pipe any remaining buffered data
        if (remainingBuffer.length > 0) {
          // Any extra bytes sent on the data socket after handshake go towards the client
          pendingConn.clientSocket.write(remainingBuffer);
        }
        // Flush any client data that arrived after SOCKS request while waiting for data socket
        if (pendingConn.clientPreData && pendingConn.clientPreData.length > 0) {
          try { socket.write(pendingConn.clientPreData); } catch {}
          pendingConn.clientPreData = Buffer.alloc(0);
        }

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

        // Stop intercepting data on client socket; switch to raw piping
        try {
          if (pendingConn.clientOnData) {
            pendingConn.clientSocket.removeListener('data', pendingConn.clientOnData);
            pendingConn.clientOnData = null;
          }
        } catch {}

        // Pipe the connections together
        pendingConn.clientSocket.pipe(socket);
        socket.pipe(pendingConn.clientSocket);

        // Cleanup mapping when either side closes
        const cleanup = () => {
          this.pendingConnections.delete(connectionId);
        };
        pendingConn.clientSocket.on('close', cleanup);
        socket.on('close', cleanup);

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
      } else if (pendingConn.targetSocket) {
        // Reverse mode: pipe data socket <-> targetSocket
        const targetSocket = pendingConn.targetSocket;

        // Wrap socket writes for traffic tracking
        const originalWrite = socket.write.bind(socket);
        socket.write = function(data) {
          if (data && data.length > 0) {
            self.incrementTraffic(portForwardId, data.length, 0);
          }
          return originalWrite(data);
        };

        const originalTargetWrite = targetSocket.write.bind(targetSocket);
        targetSocket.write = function(data) {
          if (data && data.length > 0) {
            self.incrementTraffic(portForwardId, 0, data.length);
          }
          return originalTargetWrite(data);
        };

        // Pipe the connections
        socket.pipe(targetSocket);
        targetSocket.pipe(socket);

        // Cleanup mapping when either side closes
        const cleanup = () => {
          this.pendingConnections.delete(connectionId);
        };
        targetSocket.on('close', cleanup);
        socket.on('close', cleanup);

        // Errors/cleanup
        targetSocket.on('error', () => {
          socket.destroy();
        });
        socket.on('error', () => {
          targetSocket.destroy();
        });
        targetSocket.on('end', () => {
          socket.end();
        });
        socket.on('end', () => {
          targetSocket.end();
        });
      } else {
        console.error(`Pending connection ${connectionId} missing sockets`);
        socket.destroy();
      }
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
      case "reverse_connection": {
        // Client wants the server to initiate connection to a target on server network
        const { proxyName, connectionId } = msg;
        if (!socket.clientId) {
          console.error('reverse_connection received but clientId not set');
          return;
        }
        // Lookup port forward by client and name
        this.database.getPortForwardsByClient(socket.clientId)
          .then(forwards => {
            const forward = forwards.find(f => f.name === proxyName && f.direction === 'reverse');
            if (!forward) {
              console.error(`Reverse forward [${proxyName}] not found for client ${socket.clientName}`);
              socket.write(JSON.stringify({ type: 'reverse_failed', connectionId, error: 'Forward not found' }) + "\n");
              return;
            }
            const remoteIp = forward.remote_ip || '127.0.0.1';
            const remotePort = forward.remote_port;

            // Connect to target on server side
            const targetSocket = net.createConnection(remotePort, remoteIp, () => {
              console.log(`Connected to server-side target ${remoteIp}:${remotePort} for reverse [${proxyName}]`);
              // Store pending connection awaiting data socket from client
              this.pendingConnections.set(connectionId, {
                targetSocket,
                proxyName,
                portForwardId: forward.id,
              });
              // Notify client to proceed opening data connection
              socket.write(JSON.stringify({ type: 'reverse_ready', connectionId }) + "\n");
            });

            targetSocket.setNoDelay(true);

            targetSocket.on('error', (err) => {
              console.error(`Failed to connect target for reverse [${proxyName}]:`, err.message);
              socket.write(JSON.stringify({ type: 'reverse_failed', connectionId, error: err.message }) + "\n");
            });

            // Timeout if client doesn't open data connection in time
            setTimeout(() => {
              const pending = this.pendingConnections.get(connectionId);
              if (pending && pending.targetSocket === targetSocket) {
                console.log(`Reverse connection ${connectionId} timed out waiting for data socket`);
                try { targetSocket.destroy(); } catch {}
                this.pendingConnections.delete(connectionId);
              }
            }, 10000);
          })
          .catch(err => {
            console.error('Database error during reverse_connection:', err);
            socket.write(JSON.stringify({ type: 'reverse_failed', connectionId, error: 'Server error' }) + "\n");
          });
        break;
      }
      case "dynamic_ready": {
        const { connectionId } = msg;
        const pending = this.pendingConnections.get(connectionId);
        if (!pending || !pending.clientSocket) {
          console.error(`dynamic_ready for unknown or invalid connection ${connectionId}`);
          break;
        }
        // SOCKS5 success reply
        try {
          const resp = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
          pending.clientSocket.write(resp);
        } catch (e) {
          console.error('Error sending SOCKS5 success:', e.message);
        }
        break;
      }
      case "dynamic_failed": {
        const { connectionId } = msg;
        const pending = this.pendingConnections.get(connectionId);
        if (pending && pending.clientSocket) {
          try {
            const resp = Buffer.from([0x05, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
            pending.clientSocket.write(resp);
          } catch {}
          try { pending.clientSocket.destroy(); } catch {}
          this.pendingConnections.delete(connectionId);
        } else {
          console.error(`dynamic_failed for unknown connection ${connectionId}`);
        }
        break;
      }
      case "reverse_dynamic": {
        const { proxyName, connectionId, targetHost, targetPort } = msg;
        if (!socket.clientId) {
          console.error('reverse_dynamic received but clientId not set');
          return;
        }
        this.database.getPortForwardsByClient(socket.clientId)
          .then(forwards => {
            const forward = forwards.find(f => f.name === proxyName && f.direction === 'reverse-dynamic');
            if (!forward) {
              console.error(`Reverse-dynamic forward [${proxyName}] not found for client ${socket.clientName}`);
              socket.write(JSON.stringify({ type: 'reverse_dynamic_failed', connectionId, error: 'Forward not found' }) + "\n");
              return;
            }
            const targetSocket = net.createConnection(targetPort, targetHost, () => {
              console.log(`Connected to server-side target ${targetHost}:${targetPort} for reverse-dynamic [${proxyName}]`);
              this.pendingConnections.set(connectionId, {
                targetSocket,
                proxyName,
                portForwardId: forward.id,
              });
              socket.write(JSON.stringify({ type: 'reverse_dynamic_ready', connectionId }) + "\n");
            });

            targetSocket.setNoDelay(true);
            targetSocket.on('error', (err) => {
              console.error(`Failed server-side target for reverse-dynamic [${proxyName}]:`, err.message);
              socket.write(JSON.stringify({ type: 'reverse_dynamic_failed', connectionId, error: err.message }) + "\n");
            });
            setTimeout(() => {
              const pending = this.pendingConnections.get(connectionId);
              if (pending && pending.targetSocket === targetSocket) {
                console.log(`Reverse-dynamic connection ${connectionId} timed out waiting for data socket`);
                try { targetSocket.destroy(); } catch {}
                this.pendingConnections.delete(connectionId);
              }
            }, 10000);
          })
          .catch(err => {
            console.error('Database error during reverse_dynamic:', err);
            socket.write(JSON.stringify({ type: 'reverse_dynamic_failed', connectionId, error: 'Server error' }) + "\n");
          });
        break;
      }
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
        const direction = forward.direction || 'forward';
        const remote_ip = forward.remote_ip || '127.0.0.1';
        if (direction === 'forward') {
          await this.createProxyServer(socket, {
            name: forward.name,
            remotePort: forward.remote_port,
            proxyType: forward.proxy_type,
            portForwardId: forward.id,
          });
        } else if (direction === 'dynamic') {
          await this.createProxyServer(socket, {
            name: forward.name,
            remotePort: forward.remote_port,
            proxyType: 'socks5',
            portForwardId: forward.id,
          });
          console.log(`Dynamic SOCKS5 [${forward.name}] listening on ${forward.remote_port}`);
        } else if (direction === 'reverse') {
          console.log(`Reverse forward [${forward.name}] configured: client will listen on ${forward.local_ip}:${forward.local_port}, server will connect to ${remote_ip}:${forward.remote_port}`);
        } else if (direction === 'reverse-dynamic') {
          console.log(`Reverse-Dynamic SOCKS5 [${forward.name}] configured: client will listen on ${forward.local_ip}:${forward.local_port} (SOCKS5)`);
        }
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
      clientSocket.setNoDelay(true);
      if (proxyType === 'socks5') {
        this.handleSocks5ForwardConnection(controlSocket, clientSocket, name, portForwardId);
      } else {
        this.handleProxyConnection(controlSocket, clientSocket, name, portForwardId);
      }
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

  // SOCKS5 handshake + dynamic forward: external client speaks SOCKS to server; server instructs client to connect to target
  handleSocks5ForwardConnection(controlSocket, clientSocket, proxyName, portForwardId) {
    let buf = Buffer.alloc(0);
    let stage = 'greet';
    let connectionId = null;
    // Buffer for any client data arriving after SOCKS request while we wait for data connection
    let clientPreData = Buffer.alloc(0);

    const onData = (data) => {
      buf = Buffer.concat([buf, data]);
      try {
        if (stage === 'greet') {
          if (buf.length < 2) return;
          const ver = buf[0];
          const nmethods = buf[1];
          const need = 2 + nmethods;
          if (ver !== 0x05) {
            clientSocket.destroy();
            return;
          }
          if (buf.length < need) return; // wait more
          // consume
          buf = buf.slice(need);
          // reply: no auth
          clientSocket.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        }
        if (stage === 'request') {
          if (buf.length < 4) return;
          const ver2 = buf[0];
          const cmd = buf[1];
          const atyp = buf[3];
          if (ver2 !== 0x05) { clientSocket.destroy(); return; }
          if (cmd !== 0x01) {
            clientSocket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0, 0,0]));
            clientSocket.destroy();
            return;
          }
          let addr = '';
          let port = 0;
          let offset = 4;
          if (atyp === 0x01) { // IPv4
            if (buf.length < offset + 4 + 2) return;
            addr = `${buf[offset]}.${buf[offset+1]}.${buf[offset+2]}.${buf[offset+3]}`;
            offset += 4;
          } else if (atyp === 0x03) { // domain
            if (buf.length < offset + 1) return;
            const len = buf[offset];
            if (buf.length < offset + 1 + len + 2) return;
            addr = buf.slice(offset + 1, offset + 1 + len).toString('utf8');
            offset += 1 + len;
          } else if (atyp === 0x04) { // IPv6
            if (buf.length < offset + 16 + 2) return;
            const a = [];
            for (let i = 0; i < 16; i+=2) {
              a.push(buf.slice(offset+i, offset+i+2).toString('hex'));
            }
            addr = a.join(':');
            offset += 16;
          } else {
            clientSocket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0,0,0,0, 0,0]));
            clientSocket.destroy();
            return;
          }
          port = (buf[offset] << 8) + buf[offset+1];
          buf = buf.slice(offset + 2);

          // Ask client to connect to target; data path established upon data_connection
          connectionId = genConnectionId();
          this.pendingConnections.set(connectionId, {
            clientSocket,
            proxyName,
            portForwardId,
            // Store any early client data to forward once data socket is ready
            clientPreData,
            // Save reference to this data handler so we can remove it once piping is established
            clientOnData: onData,
            ownerClientId: controlSocket.clientId,
          });
          controlSocket.write(
            JSON.stringify({ type: 'dynamic_connection', proxyName, connectionId, targetHost: addr, targetPort: port }) + "\n"
          );

          // Timeout for dynamic connection; store timer so it can be cleared on data connection
          const timer = setTimeout(() => {
            const pending = this.pendingConnections.get(connectionId);
            if (pending && pending.clientSocket === clientSocket) {
              console.log(`Dynamic connection ${connectionId} timed out`);
              try { clientSocket.destroy(); } catch {}
              this.pendingConnections.delete(connectionId);
            }
          }, this.config.dynamicTimeoutMs || 15000);
          const p = this.pendingConnections.get(connectionId);
          if (p) p.timer = timer;

          stage = 'wait';
        }
        // While waiting for data connection, accumulate any client payload
        if (stage === 'wait') {
          if (buf.length > 0 && connectionId) {
            const pending = this.pendingConnections.get(connectionId);
            if (pending) {
              // Append and clear local buffer
              pending.clientPreData = Buffer.concat([pending.clientPreData || Buffer.alloc(0), buf]);
              buf = Buffer.alloc(0);
            }
          }
        }
      } catch (e) {
        console.error('SOCKS5 handshake error:', e.message);
        try { clientSocket.destroy(); } catch {}
      }
    };

    clientSocket.on('data', onData);
    const cleanupPending = () => {
      if (connectionId) {
        const pending = this.pendingConnections.get(connectionId);
        if (pending && pending.clientSocket === clientSocket) {
          if (pending.timer) { try { clearTimeout(pending.timer); } catch {} }
          this.pendingConnections.delete(connectionId);
        }
      }
    };
    clientSocket.on('error', cleanupPending);
    clientSocket.on('close', cleanupPending);
  }

  handleProxyConnection(controlSocket, clientSocket, proxyName, portForwardId) {
    const connectionId = genConnectionId();

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

    // Cleanup on timeout; store timer so it can be cleared on data connection
    const timer = setTimeout(() => {
      const pending = this.pendingConnections.get(connectionId);
      if (pending && pending.clientSocket === clientSocket) {
        console.log(`Connection ${connectionId} timed out`);
        this.pendingConnections.delete(connectionId);
        try { clientSocket.destroy(); } catch {}
      }
    }, this.config.dynamicTimeoutMs || 15000);
    const p = this.pendingConnections.get(connectionId);
    if (p) p.timer = timer;
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

    // Clean up any pending connections owned by this client
    if (socket.clientId) {
      for (const [connectionId, pending] of this.pendingConnections.entries()) {
        if (pending.ownerClientId === socket.clientId) {
          if (pending.clientSocket && pending.clientSocket.destroyed === false) {
            try { pending.clientSocket.destroy(); } catch {}
          }
          if (pending.targetSocket && pending.targetSocket.destroyed === false) {
            try { pending.targetSocket.destroy(); } catch {}
          }
          this.pendingConnections.delete(connectionId);
        }
      }
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

      // Create new proxy servers or reverse configs
      for (const forward of newForwards) {
        if (forward.direction === 'forward') {
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
        } else if (forward.direction === 'dynamic') {
          if (!this.proxyServers.has(forward.remote_port)) {
            try {
              await this.createProxyServer(socket, {
                name: forward.name,
                remotePort: forward.remote_port,
                proxyType: 'socks5',
                portForwardId: forward.id
              });
              console.log(`Dynamic SOCKS5 [${forward.name}] listening on ${forward.remote_port}`);
            } catch (err) {
              console.error(`Failed to create dynamic SOCKS5 [${forward.name}]:`, err);
            }
          }
        } else if (forward.direction === 'reverse') {
          console.log(`Reverse forward [${forward.name}] configured: client will listen on ${forward.local_ip}:${forward.local_port}, server will connect to ${forward.remote_ip}:${forward.remote_port}`);
        }
      }

      // Send updated port forward list to client
      const portForwards = newForwards.map(f => ({
        name: f.name,
        remotePort: f.remote_port,
        localIp: f.local_ip,
        localPort: f.local_port,
        proxyType: f.proxy_type,
        direction: f.direction,
        remoteIp: f.remote_ip
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
