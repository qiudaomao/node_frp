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
      throw new Error('token is required for authentication');
    }

    // Proxies are now optional - they come from the server
    if (config.proxies && config.proxies.length > 0) {
      console.warn('Warning: proxies defined in client config will be ignored. Port forwards are managed server-side.');
    }

    return config;
  }

  static validateServerConfig(config) {
    if (!config.bindPort) {
      config.bindPort = 7000;
    }

    // Web UI configuration
    if (!config.webUI) {
      config.webUI = {};
    }

    if (typeof config.webUI.enabled === 'undefined') {
      config.webUI.enabled = true; // Enable by default
    }

    if (!config.webUI.port) {
      config.webUI.port = 8080;
    }

    if (!config.webUI.username) {
      config.webUI.username = process.env.ADMIN_USERNAME || 'admin';
      if (!process.env.ADMIN_USERNAME) {
        console.warn('Warning: Using default username. Set webUI.username in config or ADMIN_USERNAME env var for production.');
      }
    }

    if (!config.webUI.password) {
      config.webUI.password = process.env.ADMIN_PASSWORD || 'admin';
      if (!process.env.ADMIN_PASSWORD) {
        console.warn('Warning: Using default password. Set webUI.password in config or ADMIN_PASSWORD env var for production.');
      }
    }

    // Database path
    if (!config.databasePath) {
      config.databasePath = './frp.db';
    }

    // Traffic flush interval (in seconds)
    if (!config.trafficFlushInterval) {
      config.trafficFlushInterval = 30; // Default: 30 seconds
    }

    return config;
  }
}

module.exports = ConfigLoader;
