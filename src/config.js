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

    if (!config.webUI.adminPassword) {
      config.webUI.adminPassword = 'admin';
      console.warn('Warning: Using default admin password. Set webUI.adminPassword in config for production.');
    }

    if (!config.webUI.sessionSecret) {
      config.webUI.sessionSecret = 'frp-secret-change-me';
      console.warn('Warning: Using default session secret. Set webUI.sessionSecret in config for production.');
    }

    // Database path
    if (!config.databasePath) {
      config.databasePath = './frp.db';
    }

    return config;
  }
}

module.exports = ConfigLoader;
