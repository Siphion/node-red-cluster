module.exports = {
  // Enable authentication
  adminAuth: {
    type: "credentials",
    users: [{
      username: "admin",
      password: "$2b$08$KU5RJ3X1sHFmCLKZ1JXKMOh.F4rqP4i4TZFYg5Cz6KZfqYKFQYfay",  // Password: admin (change in production!)
      permissions: "*"
    }]
  },

  // Enable Projects with Git
  editorTheme: {
    projects: {
      enabled: true,
      workflow: {
        mode: "manual"
      }
    }
  },

  // Node-RED Cluster storage with Projects support
  storageModule: require('node-red-cluster/storage'),
  valkey: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    keyPrefix: 'nodered:',

    // Admin publishes updates
    publishOnSave: true,
    updateChannel: 'nodered:flows:updated',

    // Package sync: admin publishes
    syncPackages: true,
    packageSyncOnAdmin: true,
    packageChannel: 'nodered:packages:updated',

    enableCompression: true
  },

  // Context storage using Valkey/Redis
  contextStorage: {
    default: {
      module: require('node-red-cluster/context'),
      config: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        keyPrefix: 'nodered:context:',
        db: 0
      }
    }
  },

  // Persistent directory for Projects
  userDir: '/data',

  // Logging
  logging: {
    console: {
      level: "info",
      metrics: false,
      audit: false
    }
  }
};
