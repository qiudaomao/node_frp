const fs = require('fs');
const yaml = require('js-yaml');

class ConfigLoader {
  static loadYAML(filePath) {
    try {
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const config = yaml.load(fileContents);
      return config;
    } catch (err) {
      console.error('Failed to load configuration:', err.message);
      throw err;
    }
  }

  static validateClientConfig(config) {
    if (!config.serverAddr) {
      throw new Error('serverAddr is required');
    }

    if (!config.serverPort) {
      throw new Error('serverPort is required');
    }

    if (!config.token) {
      console.warn('Warning: No authentication token configured. Connection may be rejected by server.');
    }

    if (!config.proxies || config.proxies.length === 0) {
      throw new Error('At least one proxy must be configured');
    }

    config.proxies.forEach((proxy, index) => {
      if (!proxy.name) {
        throw new Error(`Proxy at index ${index} is missing name`);
      }

      if (!proxy.localPort) {
        throw new Error(`Proxy [${proxy.name}] is missing localPort`);
      }

      if (!proxy.remotePort) {
        throw new Error(`Proxy [${proxy.name}] is missing remotePort`);
      }

      // Set defaults
      if (!proxy.type) {
        proxy.type = 'tcp';
      }

      if (!proxy.localIP) {
        proxy.localIP = '127.0.0.1';
      }
    });

    return config;
  }

  static validateServerConfig(config) {
    if (!config.bindPort) {
      config.bindPort = 7000;
    }

    // Token is optional, but if not set, no auth will be performed
    if (!config.token) {
      console.warn('Warning: No authentication token configured. Server will accept all connections.');
    }

    return config;
  }
}

module.exports = ConfigLoader;
