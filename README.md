# Node FRP

A Node.js implementation of Fast Reverse Proxy (FRP) for TCP port forwarding.

## Features

- TCP port forwarding
- Client/Server architecture
- YAML configuration
- Automatic reconnection
- Heartbeat mechanism

## Installation

```bash
npm install
```

## Configuration

### Client Configuration (frpc.yaml)

```yaml
serverAddr: "your.server.ip"
serverPort: 7000

proxies:
  - name: "ssh"
    type: "tcp"
    localIP: "127.0.0.1"
    localPort: 22
    remotePort: 6000
```

### Server Configuration (frps.yaml)

```yaml
bindPort: 7000
```

## Usage

### Start Server

```bash
node src/cli.js server
# or with custom config
node src/cli.js server custom-server.yaml
```

### Start Client

```bash
node src/cli.js client
# or with custom config
node src/cli.js client custom-client.yaml
```

## How It Works

1. Client connects to server on control port (default 7000)
2. Client registers proxies with the server
3. Server opens listening ports for each proxy
4. When someone connects to a remote port:
   - Server notifies client
   - Client establishes data connection to server
   - Client connects to local service
   - Data is forwarded: Remote Client <-> Server <-> FRP Client <-> Local Service

## Example

Forward local SSH (port 22) to remote port 6000:

**On server machine:**
```bash
node src/cli.js server
```

**On client machine (with SSH service on port 22):**
```bash
# Edit frpc.yaml to point to your server IP
node src/cli.js client
```

**Access SSH from anywhere:**
```bash
ssh user@server-ip -p 6000
```
