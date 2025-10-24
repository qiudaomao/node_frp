const net = require("net");

class FRPServer {
  constructor(config) {
    this.config = config;
    this.controlServer = null;
    this.proxyServers = new Map();
    this.clients = new Map();
    this.pendingConnections = new Map();
  }

  start() {
    const port = this.config.bindPort || 7000;

    this.controlServer = net.createServer((socket) => {
      this.handleControlConnection(socket);
    });

    this.controlServer.listen(port, () => {
      console.log(`FRP Server started on port ${port}`);
    });

    this.controlServer.on("error", (err) => {
      console.error("Server error:", err);
    });
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

    const onData = (data) => {
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

            // Check token if configured
            if (this.config.token) {
              if (!msg.token || msg.token !== this.config.token) {
                console.error(
                  "Authentication failed: Invalid token from",
                  socket.remoteAddress,
                );
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
              authenticated = true;
              console.log("Client authenticated successfully");
            } else {
              // No token configured, skip authentication
              authenticated = true;
            }

            handshakeComplete = true;

            // Send auth success response
            socket.write(
              JSON.stringify({
                type: "auth_response",
                success: true,
              }) + "\n",
            );

            // Start heartbeat monitoring after successful authentication
            startHeartbeatTimeout();

            buffer = buffer.substring(newlineIndex + 1);

            // Continue processing any remaining messages
            this.processControlMessages(socket, buffer, startHeartbeatTimeout);

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

      // Pipe the connections together
      pendingConn.clientSocket.pipe(socket);
      socket.pipe(pendingConn.clientSocket);

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
        this.registerProxy(socket, msg);
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

  registerProxy(socket, msg) {
    const { name, proxyType, remotePort } = msg;

    if (this.proxyServers.has(remotePort)) {
      socket.write(
        JSON.stringify({
          type: "register_response",
          success: false,
          error: `Port ${remotePort} already in use`,
        }) + "\n",
      );
      return;
    }

    // Create proxy server for this remote port
    const proxyServer = net.createServer((clientSocket) => {
      this.handleProxyConnection(socket, clientSocket, name);
    });

    proxyServer.listen(remotePort, () => {
      console.log(`Proxy [${name}] listening on port ${remotePort}`);

      this.proxyServers.set(remotePort, {
        server: proxyServer,
        name: name,
        controlSocket: socket,
      });

      if (!this.clients.has(socket)) {
        this.clients.set(socket, []);
      }
      this.clients.get(socket).push(remotePort);

      socket.write(
        JSON.stringify({
          type: "register_response",
          success: true,
          name: name,
        }) + "\n",
      );
    });

    proxyServer.on("error", (err) => {
      console.error(`Proxy [${name}] error:`, err);
      socket.write(
        JSON.stringify({
          type: "register_response",
          success: false,
          error: err.message,
        }) + "\n",
      );
    });
  }

  handleProxyConnection(controlSocket, clientSocket, proxyName) {
    const connectionId = Math.random().toString(36).substring(7);

    console.log(`New connection to proxy [${proxyName}], id: ${connectionId}`);

    // Store pending connection
    this.pendingConnections.set(connectionId, {
      clientSocket: clientSocket,
      proxyName: proxyName,
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

    // Clean up any pending connections for this client
    for (const [connectionId, pending] of this.pendingConnections.entries()) {
      if (pending.clientSocket && pending.clientSocket.destroyed === false) {
        pending.clientSocket.destroy();
      }
      this.pendingConnections.delete(connectionId);
    }
  }

  stop() {
    if (this.controlServer) {
      this.controlServer.close();
    }
    this.proxyServers.forEach((proxy) => {
      proxy.server.close();
    });
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
