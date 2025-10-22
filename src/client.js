const net = require('net');

class FRPClient {
  constructor(config) {
    this.config = config;
    this.controlSocket = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connected = false;
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

      // Send control connection handshake
      this.controlSocket.write(JSON.stringify({
        type: 'control_handshake'
      }) + '\n');

      this.registerProxies();
      this.startHeartbeat();
    });

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
      case 'register_response':
        this.handleRegisterResponse(msg);
        break;
      case 'new_connection':
        this.handleNewConnection(msg);
        break;
      case 'heartbeat_ack':
        // Heartbeat acknowledged
        break;
      default:
        console.log('Unknown message type:', msg.type);
    }
  }

  handleRegisterResponse(msg) {
    if (msg.success) {
      console.log(`Proxy [${msg.name}] registered successfully`);
    } else {
      console.error(`Proxy [${msg.name}] registration failed:`, msg.error);
    }
  }

  handleNewConnection(msg) {
    const { proxyName, connectionId } = msg;

    const proxy = this.config.proxies.find(p => p.name === proxyName);
    if (!proxy) {
      console.error(`Proxy [${proxyName}] not found`);
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

        // Connect to local service
        const localSocket = net.createConnection(
          proxy.localPort,
          proxy.localIP || '127.0.0.1',
          () => {
            console.log(`Connected to local service ${proxy.localIP}:${proxy.localPort}`);

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

        localSocket.on('error', (err) => {
          console.error(`Failed to connect to local service: ${err.message}`);
          dataSocket.destroy();
        });
      }
    );

    dataSocket.on('error', (err) => {
      console.error('Failed to establish data connection:', err.message);
    });
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

    if (this.controlSocket) {
      this.controlSocket.end();
    }
  }
}

module.exports = FRPClient;
