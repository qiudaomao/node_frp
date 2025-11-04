#!/usr/bin/env node
const FRPServer = require('./server');
const FRPClient = require('./client');
const ConfigLoader = require('./config');

const args = process.argv.slice(2);

function printUsage() {
  console.log(`
Usage:
  node-frp server [config_file]    Start FRP server (includes web UI)
  node-frp client [config_file]    Start FRP client

Default config files:
  Server: ./frps.yaml
  Client: ./frpc.yaml

Examples:
  node-frp server                  Start server with default config
  node-frp client                  Start client with default config
  node-frp server custom.yaml      Start server with custom config
  node-frp client custom.yaml      Start client with custom config

Web UI:
  The web UI is automatically started with the server if enabled in config.
  Access it via browser at http://localhost:<webUI.port> (default: 8080)
  `);
}

function main() {
  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const mode = args[0];
  const configFile = args[1];

  if (mode === 'server') {
    const file = configFile || './frps.yaml';
    console.log(`Loading server configuration from ${file}`);

    try {
      const config = ConfigLoader.loadYAML(file);
      const validatedConfig = ConfigLoader.validateServerConfig(config);
      const server = new FRPServer(validatedConfig);

      server.start();

      process.on('SIGINT', () => {
        console.log('\nShutting down server...');
        server.stop();
        process.exit(0);
      });
    } catch (err) {
      console.error('Failed to start server:', err.message);
      process.exit(1);
    }
  } else if (mode === 'client') {
    const file = configFile || './frpc.yaml';
    console.log(`Loading client configuration from ${file}`);

    try {
      const config = ConfigLoader.loadYAML(file);
      const validatedConfig = ConfigLoader.validateClientConfig(config);
      const client = new FRPClient(validatedConfig);

      client.start();

      process.on('SIGINT', () => {
        console.log('\nShutting down client...');
        client.stop();
        process.exit(0);
      });
    } catch (err) {
      console.error('Failed to start client:', err.message);
      process.exit(1);
    }
  } else {
    console.error(`Unknown mode: ${mode}`);
    printUsage();
    process.exit(1);
  }
}

main();
