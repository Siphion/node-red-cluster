/**
 * Valkey Configuration Node
 * Stores connection settings for Redis/Valkey server
 */

module.exports = function (RED) {
  function ValkeyConfigNode(config) {
    RED.nodes.createNode(this, config);
    this.host = config.host;
    this.port = config.port;
    this.database = config.database;
    this.name = config.name;
  }

  RED.nodes.registerType('valkey-config', ValkeyConfigNode, {
    credentials: {
      password: { type: 'password' },
    },
  });
};
