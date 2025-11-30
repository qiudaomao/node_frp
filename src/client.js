const net = require('net');
const dgram = require('dgram');

function genConnectionId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

class FRPClient {
  constructor(config) {
    this.config = config;
    this.controlSocket = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connected = false;
    this.assignedProxies = []; // Store port forwards assigned by server
    this.reverseServers = new Map(); // name -> net.Server for reverse forwards
    this.pendingLocalConnections = new Map(); // connectionId -> { localSocket, proxyName }
    this.socksServers = new Map(); // name -> net.Server for reverse-dynamic SOCKS5
    this.udpSessions = new Map(); // connectionId -> { socket, targetHost, targetPort }
  }

  start() {
    this.connect();
  }

  connect() {
    const serverAddr = this.config.serverAddr;
    const serverPort = this.config.serverPort || 7000;

    console.log(`Connecting to FRP server ${serverAddr}:${serverPort}...`);

    this.controlSocket = net.createConnection(serverPort, serverAddr, () => {
      console.log('Connected to FRP server');
      this.connected = true;

      // Send control connection handshake with authentication token
      const handshake = {
        type: 'control_handshake'
      };

      if (this.config.token) {
        handshake.token = this.config.token;
      }

      this.controlSocket.write(JSON.stringify(handshake) + '\n');
    });

    this.controlSocket.setNoDelay(true);

    let buffer = '';

    this.controlSocket.on('data', (data) => {
      buffer += data.toString();

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const message = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);

        try {
          const msg = JSON.parse(message);
          this.handleMessage(msg);
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      }
    });

    this.controlSocket.on('end', () => {
      console.log('Disconnected from server');
      this.handleDisconnect();
    });

    this.controlSocket.on('error', (err) => {
      console.error('Connection error:', err.message);
      this.handleDisconnect();
    });
  }

  registerProxies() {
    if (!this.config.proxies || this.config.proxies.length === 0) {
      console.error('No proxies configured');
      return;
    }

    this.config.proxies.forEach(proxy => {
      const msg = {
        type: 'register',
        name: proxy.name,
        proxyType: proxy.type || 'tcp',
        remotePort: proxy.remotePort
      };

      this.controlSocket.write(JSON.stringify(msg) + '\n');
      console.log(`Registering proxy [${proxy.name}]...`);
    });
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'auth_response':
        this.handleAuthResponse(msg);
        break;
      case 'register_response':
        this.handleRegisterResponse(msg);
        break;
      case 'new_connection':
        this.handleNewConnection(msg);
        break;
      case 'config_update':
        this.handleConfigUpdate(msg);
        break;
      case 'reverse_ready': {
        const { connectionId } = msg;
        const pending = this.pendingLocalConnections.get(connectionId);
        if (!pending) {
          console.error(`reverse_ready for unknown connection ${connectionId}`);
          break;
        }
        // Open data socket to server and pipe to local socket
        const dataSocket = net.createConnection(
          this.config.serverPort,
          this.config.serverAddr,
          () => {
            dataSocket.write(JSON.stringify({ type: 'data_connection', connectionId }) + '\n');

            const localSocket = pending.localSocket;
            // Pipe data between server and local client
            dataSocket.pipe(localSocket);
            localSocket.pipe(dataSocket);

            dataSocket.on('error', (err) => {
              console.error('Data socket error (reverse):', err.message);
              try { localSocket.destroy(); } catch {}
              this.pendingLocalConnections.delete(connectionId);
            });
            localSocket.on('error', (err) => {
              console.error('Local socket error (reverse):', err.message);
              try { dataSocket.destroy(); } catch {}
              this.pendingLocalConnections.delete(connectionId);
            });
            dataSocket.on('end', () => {
              try { localSocket.end(); } catch {}
              this.pendingLocalConnections.delete(connectionId);
            });
            localSocket.on('end', () => {
              try { dataSocket.end(); } catch {}
              this.pendingLocalConnections.delete(connectionId);
            });
          }
        );
        dataSocket.setNoDelay(true);
        dataSocket.on('error', (err) => {
          console.error('Failed to establish reverse data connection:', err.message);
          const localSocket = pending.localSocket;
          try { localSocket.destroy(); } catch {}
          this.pendingLocalConnections.delete(connectionId);
        });
        break;
      }
      case 'reverse_failed': {
        const { connectionId, error } = msg;
        const pending = this.pendingLocalConnections.get(connectionId);
        if (pending) {
          try { pending.localSocket.destroy(); } catch {}
          this.pendingLocalConnections.delete(connectionId);
        }
        console.error(`Reverse connection failed: ${error || 'Unknown error'}`);
        break;
      }
      case 'dynamic_connection': {
        // Server requests client to open a connection to target for forward dynamic SOCKS
        const { proxyName, connectionId, targetHost, targetPort } = msg;
        const dataSocket = net.createConnection(
          this.config.serverPort,
          this.config.serverAddr,
          () => {
            dataSocket.write(JSON.stringify({ type: 'data_connection', connectionId }) + '\n');
            const targetSocket = net.createConnection(targetPort, targetHost, () => {
              // Bridge target <-> dataSocket
              dataSocket.pipe(targetSocket);
              targetSocket.pipe(dataSocket);
              this.controlSocket.write(JSON.stringify({ type: 'dynamic_ready', connectionId }) + '\n');
            });
            targetSocket.setNoDelay(true);
            targetSocket.on('error', (err) => {
              console.error('Client failed to connect target for dynamic:', err.message);
              // Still notify server about failure. Ensure data socket closes after sending the message
              try {
                this.controlSocket.write(JSON.stringify({ type: 'dynamic_failed', connectionId, error: err.message }) + '\n');
              } finally {
                try { dataSocket.destroy(); } catch {}
              }
            });
          }
        );
        dataSocket.setNoDelay(true);
        dataSocket.on('error', (err) => {
          console.error('Failed to establish data socket for dynamic:', err.message);
        });
        break;
      }
      case 'reverse_dynamic_ready': {
        const { connectionId } = msg;
        const pending = this.pendingLocalConnections.get(connectionId);
        if (!pending) {
          console.error(`reverse_dynamic_ready for unknown connection ${connectionId}`);
          break;
        }
        const dataSocket = net.createConnection(this.config.serverPort, this.config.serverAddr, () => {
          dataSocket.write(JSON.stringify({ type: 'data_connection', connectionId }) + '\n');
          const localSocket = pending.localSocket;
          // Send SOCKS5 success reply to local client
          try {
            const resp = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
            localSocket.write(resp);
          } catch {}
          dataSocket.pipe(localSocket);
          localSocket.pipe(dataSocket);
        });
        dataSocket.setNoDelay(true);
        dataSocket.on('error', (err) => {
          console.error('Data socket error (reverse-dynamic):', err.message);
          const localSocket = pending.localSocket;
          try { localSocket.destroy(); } catch {}
          this.pendingLocalConnections.delete(connectionId);
        });
        break;
      }
      case 'reverse_dynamic_failed': {
        const { connectionId, error } = msg;
        const pending = this.pendingLocalConnections.get(connectionId);
        if (pending) {
          try {
            const resp = Buffer.from([0x05, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
            pending.localSocket.write(resp);
          } catch {}
          try { pending.localSocket.destroy(); } catch {}
          this.pendingLocalConnections.delete(connectionId);
        }
        console.error(`Reverse-dynamic connection failed: ${error || 'Unknown error'}`);
        break;
      }
      case 'udp_packet':
        this.handleUdpPacket(msg);
        break;
      case 'udp_close':
        if (msg.connectionId) {
          this.closeUdpSession(msg.connectionId, false);
        }
        break;
      case 'heartbeat_ack':
        // Heartbeat acknowledged
        break;
      default:
        console.log('Unknown message type:', msg.type);
    }
  }

  handleAuthResponse(msg) {
    if (msg.success) {
      console.log('Authentication successful');

      // Handle port forward assignments from server
      if (msg.portForwards && Array.isArray(msg.portForwards)) {
        this.assignedProxies = msg.portForwards;
        console.log(`Server assigned ${this.assignedProxies.length} port forwards:`);
        this.assignedProxies.forEach(proxy => {
          const dir = proxy.direction || 'forward';
          if (dir === 'reverse') {
            console.log(`  - ${proxy.name} [reverse]: listen ${proxy.localIp}:${proxy.localPort} => ${proxy.remoteIp}:${proxy.remotePort}`);
          } else if (dir === 'dynamic') {
            console.log(`  - ${proxy.name} [dynamic]: SOCKS5 on server port ${proxy.remotePort}`);
          } else if (dir === 'reverse-dynamic') {
            console.log(`  - ${proxy.name} [reverse-dynamic]: SOCKS5 on client ${proxy.localIp}:${proxy.localPort}`);
          } else {
            console.log(`  - ${proxy.name} [forward]: ${proxy.localIp}:${proxy.localPort} -> localhost:${proxy.remotePort} (${proxy.proxyType})`);
          }
        });

        // Setup reverse listeners
        const desiredReverseNames = new Set();
        this.assignedProxies.filter(p => p.direction === 'reverse').forEach(forward => {
          desiredReverseNames.add(forward.name);
          if (!this.reverseServers.has(forward.name)) {
            const server = net.createServer((localSocket) => {
              localSocket.setNoDelay(true);
              if (!this.connected || !this.controlSocket) {
                console.error('Control connection not ready; rejecting reverse connection');
                try { localSocket.destroy(); } catch {}
                return;
              }
              const connectionId = genConnectionId();
              this.pendingLocalConnections.set(connectionId, { localSocket, proxyName: forward.name });
              // Inform server to connect to target
              this.controlSocket.write(JSON.stringify({ type: 'reverse_connection', proxyName: forward.name, connectionId }) + '\n');

              // Cleanup if local closes early
              localSocket.on('close', () => {
                this.pendingLocalConnections.delete(connectionId);
              });
            });
            server.listen(forward.localPort, forward.localIp || '127.0.0.1', () => {
              console.log(`Reverse listener [${forward.name}] on ${forward.localIp}:${forward.localPort}`);
            });
            server.on('error', (err) => {
              console.error(`Reverse listener error [${forward.name}]:`, err.message);
            });
            this.reverseServers.set(forward.name, server);
          }
        });
        // Setup reverse-dynamic SOCKS servers
        this.assignedProxies.filter(p => p.direction === 'reverse-dynamic').forEach(forward => {
          desiredReverseNames.add(forward.name);
          if (!this.socksServers.has(forward.name)) {
            const server = net.createServer((localSocket) => {
              localSocket.setNoDelay(true);
              // Minimal SOCKS5 greet/request to extract target, then ask server to connect
              let buf = Buffer.alloc(0);
              let stage = 'greet';
              let connectionId = null;
              localSocket.on('data', (data) => {
                buf = Buffer.concat([buf, data]);
                if (stage === 'greet') {
                  if (buf.length < 2) return;
                  const ver = buf[0]; const nmethods = buf[1];
                  const need = 2 + nmethods;
                  if (ver !== 0x05) { try { localSocket.destroy(); } catch {}; return; }
                  if (buf.length < need) return;
                  buf = buf.slice(need);
                  localSocket.write(Buffer.from([0x05, 0x00]));
                  stage = 'request';
                }
                if (stage === 'request') {
                  if (buf.length < 4) return;
                  const ver2 = buf[0]; const cmd = buf[1]; const atyp = buf[3];
                  if (ver2 !== 0x05) { try { localSocket.destroy(); } catch {}; return; }
                  if (cmd !== 0x01) { try { localSocket.destroy(); } catch {}; return; }
                  let addr = ''; let port = 0; let offset = 4;
                  if (atyp === 0x01) {
                    if (buf.length < offset + 4 + 2) return;
                    addr = `${buf[offset]}.${buf[offset+1]}.${buf[offset+2]}.${buf[offset+3]}`; offset += 4;
                  } else if (atyp === 0x03) {
                    if (buf.length < offset + 1) return;
                    const len = buf[offset];
                    if (buf.length < offset + 1 + len + 2) return;
                    addr = buf.slice(offset + 1, offset + 1 + len).toString('utf8');
                    offset += 1 + len;
                  } else if (atyp === 0x04) {
                    if (buf.length < offset + 16 + 2) return;
                    const a = []; for (let i = 0; i < 16; i+=2) { a.push(buf.slice(offset+i, offset+i+2).toString('hex')); }
                    addr = a.join(':'); offset += 16;
                  } else {
                    try { localSocket.destroy(); } catch {}; return;
                  }
                  port = (buf[offset] << 8) + buf[offset+1];
                  buf = buf.slice(offset + 2);
                  connectionId = genConnectionId();
                  this.pendingLocalConnections.set(connectionId, { localSocket, proxyName: forward.name });
                  this.controlSocket.write(JSON.stringify({ type: 'reverse_dynamic', proxyName: forward.name, connectionId, targetHost: addr, targetPort: port }) + '\n');
                  stage = 'wait';
                }
              });
              localSocket.on('close', () => {
                if (connectionId) this.pendingLocalConnections.delete(connectionId);
              });
            });
            server.listen(forward.localPort, forward.localIp || '127.0.0.1', () => {
              console.log(`Reverse-dynamic SOCKS [${forward.name}] on ${forward.localIp}:${forward.localPort}`);
            });
            server.on('error', (err) => {
              console.error(`Reverse-dynamic SOCKS error [${forward.name}]:`, err.message);
            });
            this.socksServers.set(forward.name, server);
          }
        });
        // Close any reverse servers no longer desired
        for (const [name, srv] of this.reverseServers.entries()) {
          if (!desiredReverseNames.has(name)) {
            try { srv.close(); } catch {}
            this.reverseServers.delete(name);
            console.log(`Closed reverse listener [${name}]`);
          }
        }
        for (const [name, srv] of this.socksServers.entries()) {
          if (!desiredReverseNames.has(name)) {
            try { srv.close(); } catch {}
            this.socksServers.delete(name);
            console.log(`Closed reverse-dynamic SOCKS [${name}]`);
          }
        }
      }

      this.startHeartbeat();
    } else {
      console.error('Authentication failed:', msg.error);
      this.controlSocket.destroy();
    }
  }

  handleRegisterResponse(msg) {
    if (msg.success) {
      console.log(`Proxy [${msg.name}] registered successfully`);
    } else {
      console.error(`Proxy [${msg.name}] registration failed:`, msg.error);
    }
  }

  handleConfigUpdate(msg) {
    if (msg.portForwards && Array.isArray(msg.portForwards)) {
      const oldProxies = this.assignedProxies.length;
      this.assignedProxies = msg.portForwards;

      console.log(`Configuration updated! Server assigned ${this.assignedProxies.length} port forwards:`);
      this.assignedProxies.forEach(proxy => {
        const dir = proxy.direction || 'forward';
        if (dir === 'reverse') {
          console.log(`  - ${proxy.name} [reverse]: listen ${proxy.localIp}:${proxy.localPort} => ${proxy.remoteIp}:${proxy.remotePort}`);
        } else if (dir === 'dynamic') {
          console.log(`  - ${proxy.name} [dynamic]: SOCKS5 on server port ${proxy.remotePort}`);
        } else if (dir === 'reverse-dynamic') {
          console.log(`  - ${proxy.name} [reverse-dynamic]: SOCKS5 on client ${proxy.localIp}:${proxy.localPort}`);
        } else {
          console.log(`  - ${proxy.name} [forward]: ${proxy.localIp}:${proxy.localPort} -> localhost:${proxy.remotePort} (${proxy.proxyType})`);
        }
      });

      if (this.assignedProxies.length > oldProxies) {
        console.log(`✓ ${this.assignedProxies.length - oldProxies} new port forward(s) activated`);
      } else if (this.assignedProxies.length < oldProxies) {
        console.log(`✓ ${oldProxies - this.assignedProxies.length} port forward(s) removed`);
      } else {
        console.log(`✓ Port forward configuration updated`);
      }

      // Update reverse listeners
      const desiredReverseNames = new Set();
      this.assignedProxies.filter(p => p.direction === 'reverse').forEach(forward => {
        desiredReverseNames.add(forward.name);
        if (!this.reverseServers.has(forward.name)) {
          const server = net.createServer((localSocket) => {
            localSocket.setNoDelay(true);
            const connectionId = genConnectionId();
            this.pendingLocalConnections.set(connectionId, { localSocket, proxyName: forward.name });
            this.controlSocket.write(JSON.stringify({ type: 'reverse_connection', proxyName: forward.name, connectionId }) + '\n');
            localSocket.on('close', () => {
              this.pendingLocalConnections.delete(connectionId);
            });
          });
          server.listen(forward.localPort, forward.localIp || '127.0.0.1', () => {
            console.log(`Reverse listener [${forward.name}] on ${forward.localIp}:${forward.localPort}`);
          });
          server.on('error', (err) => {
            console.error(`Reverse listener error [${forward.name}]:`, err.message);
          });
          this.reverseServers.set(forward.name, server);
        }
      });
      this.assignedProxies.filter(p => p.direction === 'reverse-dynamic').forEach(forward => {
        desiredReverseNames.add(forward.name);
        if (!this.socksServers.has(forward.name)) {
          const server = net.createServer((localSocket) => {
            localSocket.setNoDelay(true);
            let buf = Buffer.alloc(0);
            let stage = 'greet';
            let connectionId = null;
            localSocket.on('data', (data) => {
              buf = Buffer.concat([buf, data]);
              if (stage === 'greet') {
                if (buf.length < 2) return;
                const ver = buf[0]; const nmethods = buf[1];
                const need = 2 + nmethods;
                if (ver !== 0x05) { try { localSocket.destroy(); } catch {}; return; }
                if (buf.length < need) return;
                buf = buf.slice(need);
                localSocket.write(Buffer.from([0x05, 0x00]));
                stage = 'request';
              }
              if (stage === 'request') {
                if (buf.length < 4) return;
                const ver2 = buf[0]; const cmd = buf[1]; const atyp = buf[3];
                if (ver2 !== 0x05) { try { localSocket.destroy(); } catch {}; return; }
                if (cmd !== 0x01) { try { localSocket.destroy(); } catch {}; return; }
                let addr = ''; let port = 0; let offset = 4;
                if (atyp === 0x01) {
                  if (buf.length < offset + 4 + 2) return;
                  addr = `${buf[offset]}.${buf[offset+1]}.${buf[offset+2]}.${buf[offset+3]}`; offset += 4;
                } else if (atyp === 0x03) {
                  if (buf.length < offset + 1) return;
                  const len = buf[offset];
                  if (buf.length < offset + 1 + len + 2) return;
                  addr = buf.slice(offset + 1, offset + 1 + len).toString('utf8');
                  offset += 1 + len;
                } else if (atyp === 0x04) {
                  if (buf.length < offset + 16 + 2) return;
                  const a = []; for (let i = 0; i < 16; i+=2) { a.push(buf.slice(offset+i, offset+i+2).toString('hex')); }
                  addr = a.join(':'); offset += 16;
                } else { try { localSocket.destroy(); } catch {}; return; }
                port = (buf[offset] << 8) + buf[offset+1];
                buf = buf.slice(offset + 2);
                connectionId = genConnectionId();
                this.pendingLocalConnections.set(connectionId, { localSocket, proxyName: forward.name });
                this.controlSocket.write(JSON.stringify({ type: 'reverse_dynamic', proxyName: forward.name, connectionId, targetHost: addr, targetPort: port }) + '\n');
                stage = 'wait';
              }
            });
            localSocket.on('close', () => {
              if (connectionId) this.pendingLocalConnections.delete(connectionId);
            });
          });
          server.listen(forward.localPort, forward.localIp || '127.0.0.1', () => {
            console.log(`Reverse-dynamic SOCKS [${forward.name}] on ${forward.localIp}:${forward.localPort}`);
          });
          server.on('error', (err) => {
            console.error(`Reverse-dynamic SOCKS error [${forward.name}]:`, err.message);
          });
          this.socksServers.set(forward.name, server);
        }
      });
      for (const [name, srv] of this.reverseServers.entries()) {
        if (!desiredReverseNames.has(name)) {
          try { srv.close(); } catch {}
          this.reverseServers.delete(name);
          console.log(`Closed reverse listener [${name}]`);
        }
      }
      for (const [name, srv] of this.socksServers.entries()) {
        if (!desiredReverseNames.has(name)) {
          try { srv.close(); } catch {}
          this.socksServers.delete(name);
          console.log(`Closed reverse-dynamic SOCKS [${name}]`);
        }
      }
    } else {
      console.error('Received config_update without portForwards data');
    }
  }

  handleNewConnection(msg) {
    const { proxyName, connectionId } = msg;

    // Find proxy in assigned proxies from server
    const proxy = this.assignedProxies.find(p => p.name === proxyName);
    if (!proxy) {
      console.error(`Proxy [${proxyName}] not found in assigned port forwards`);
      return;
    }

    console.log(`New connection request for [${proxyName}], id: ${connectionId}`);

    // Establish data connection to server
    const dataSocket = net.createConnection(
      this.config.serverPort,
      this.config.serverAddr,
      () => {
        // Send handshake
        dataSocket.write(JSON.stringify({
          type: 'data_connection',
          connectionId: connectionId
        }) + '\n');

        // Connect to local service using assigned proxy configuration
        const localSocket = net.createConnection(
          proxy.localPort,
          proxy.localIp || '127.0.0.1',
          () => {
            console.log(`Connected to local service ${proxy.localIp}:${proxy.localPort}`);

            // Pipe data between server and local service
            dataSocket.pipe(localSocket);
            localSocket.pipe(dataSocket);

            dataSocket.on('error', (err) => {
              console.error('Data socket error:', err.message);
              localSocket.destroy();
            });

            localSocket.on('error', (err) => {
              console.error('Local socket error:', err.message);
              dataSocket.destroy();
            });

            dataSocket.on('end', () => {
              localSocket.end();
            });

            localSocket.on('end', () => {
              dataSocket.end();
            });
          }
        );

        localSocket.setNoDelay(true);

        localSocket.on('error', (err) => {
          console.error(`Failed to connect to local service: ${err.message}`);
          dataSocket.destroy();
        });
      }
    );

    dataSocket.setNoDelay(true);

    dataSocket.on('error', (err) => {
      console.error('Failed to establish data connection:', err.message);
    });
  }

  handleUdpPacket(msg) {
    const { connectionId, data, targetHost, targetPort, proxyName } = msg;
    if (!connectionId || !data) {
      return;
    }

    let session = this.udpSessions.get(connectionId);
    if (!session) {
      if (!targetHost || !targetPort) {
        console.error(`Missing target information for UDP proxy [${proxyName || 'unknown'}]`);
        return;
      }
      const socketType = targetHost && targetHost.includes(':') ? 'udp6' : 'udp4';
      const socket = dgram.createSocket(socketType);
      socket.on('message', (packet) => {
        this.sendUdpResponse(connectionId, packet);
      });
      socket.on('error', (err) => {
        console.error(`UDP session error [${proxyName || connectionId}]:`, err.message);
        this.closeUdpSession(connectionId, true);
      });
      session = {
        socket,
        targetHost,
        targetPort,
        proxyName,
      };
      this.udpSessions.set(connectionId, session);
    }

    try {
      const payload = Buffer.from(data, 'base64');
      session.socket.send(payload, session.targetPort, session.targetHost, (err) => {
        if (err) {
          console.error(`Failed to send UDP payload for ${proxyName || connectionId}:`, err.message);
        }
      });
    } catch (err) {
      console.error('Failed to process udp_packet:', err.message);
    }
  }

  sendUdpResponse(connectionId, packet) {
    if (!this.controlSocket || this.controlSocket.destroyed) {
      return;
    }
    try {
      this.controlSocket.write(
        JSON.stringify({
          type: 'udp_packet_response',
          connectionId,
          data: packet.toString('base64'),
        }) + '\n'
      );
    } catch (err) {
      console.error('Failed to send UDP response to server:', err.message);
    }
  }

  closeUdpSession(connectionId, notifyServer = false) {
    const session = this.udpSessions.get(connectionId);
    if (!session) {
      return;
    }
    this.udpSessions.delete(connectionId);
    try {
      session.socket.close();
    } catch {}
    if (notifyServer && this.controlSocket && !this.controlSocket.destroyed) {
      try {
        this.controlSocket.write(JSON.stringify({ type: 'udp_close', connectionId }) + '\n');
      } catch {}
    }
  }

  cleanupUdpSessions() {
    for (const connectionId of this.udpSessions.keys()) {
      this.closeUdpSession(connectionId, false);
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.connected && this.controlSocket) {
        this.controlSocket.write(JSON.stringify({ type: 'heartbeat' }) + '\n');
      }
    }, 30000); // Send heartbeat every 30 seconds
  }

  handleDisconnect() {
    this.connected = false;

    this.cleanupUdpSessions();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.controlSocket) {
      this.controlSocket.destroy();
      this.controlSocket = null;
    }

    // Reconnect after 5 seconds
    console.log('Reconnecting in 5 seconds...');
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, 5000);
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.cleanupUdpSessions();

    if (this.controlSocket) {
      this.controlSocket.end();
    }
  }
}

module.exports = FRPClient;
