module.exports = {
  // Disable editor on workers
  httpAdminRoot: false,

  // Projects disabled on workers
  editorTheme: {
    projects: {
      enabled: false
    },
    palette: {
      editable: false
    }
  },

  // Node-RED Cluster storage without Projects
  storageModule: require('node-red-cluster'),
  valkey: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    keyPrefix: 'nodered:',

    // Worker subscribes and auto-restarts
    subscribeToUpdates: true,
    updateChannel: 'nodered:flows:updated',

    // Package sync: worker installs
    syncPackages: true,
    packageSyncOnWorker: true,
    packageChannel: 'nodered:packages:updated',

    enableCompression: true
  },

  // Ephemeral directory
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
