/**
 * Release Cluster Leader Node for Node-RED
 * Releases the leadership lock for a specific lock key
 */
const IoRedis = require('ioredis');
const { hostname: osHostname } = require('os');

module.exports = function (RED) {
  function ReleaseClusterLeaderNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Get configuration
    const valkeyConfig = RED.nodes.getNode(config.valkey);
    const lockKey = config.lockKey || 'nodered:leader';
    const hostname = process.env.HOSTNAME || osHostname();

    // Redis client setup
    let redisClient = null;
    let isConnected = false;

    // Initialize Redis connection
    async function initRedis() {
      try {
        const redisConfig = {
          host: valkeyConfig ? valkeyConfig.host : process.env.REDIS_HOST || 'redis',
          port: valkeyConfig ? valkeyConfig.port : parseInt(process.env.REDIS_PORT || '6379'),
          db: valkeyConfig ? valkeyConfig.database : 0,
          lazyConnect: true,
          retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
          },
        };

        if (valkeyConfig && valkeyConfig.credentials && valkeyConfig.credentials.password) {
          redisConfig.password = valkeyConfig.credentials.password;
        }

        const client = new IoRedis.Redis(redisConfig);
        redisClient = client;

        client.on('error', (err) => {
          node.error('Redis error: ' + err.message);
          node.status({ fill: 'red', shape: 'ring', text: 'connection error' });
          isConnected = false;
        });

        client.on('connect', () => {
          node.log('Connected to Redis/Valkey');
          isConnected = true;
        });

        await client.connect();
      } catch (err) {
        node.error('Failed to connect to Redis: ' + err.message);
        node.status({ fill: 'red', shape: 'ring', text: 'connection failed' });
      }
    }

    // Initialize on startup
    initRedis();

    // Handle incoming messages
    node.on('input', async function (msg) {
      if (!isConnected) {
        node.warn('Not connected to Redis, dropping message');
        return;
      }

      try {
        const currentLeader = await redisClient.get(lockKey);

        if (currentLeader === hostname) {
          // This node is the leader, release the lock
          await redisClient.del(lockKey);
          node.log('Released leadership lock');
          node.status({ fill: 'green', shape: 'dot', text: 'lock released' });

          msg.lockReleased = true;
          msg.releasedBy = hostname;
          msg.lockKey = lockKey;
          node.send(msg);
        } else if (currentLeader) {
          // Another node is the leader
          node.warn(`Cannot release lock - leader is ${currentLeader}`);
          node.status({ fill: 'yellow', shape: 'ring', text: `leader: ${currentLeader.substring(0, 12)}` });

          msg.lockReleased = false;
          msg.currentLeader = currentLeader;
          msg.lockKey = lockKey;
          node.send(msg);
        } else {
          // No current leader
          node.log('No lock to release');
          node.status({ fill: 'grey', shape: 'ring', text: 'no lock' });

          msg.lockReleased = false;
          msg.lockKey = lockKey;
          node.send(msg);
        }
      } catch (err) {
        node.error('Lock release failed: ' + err.message);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    });

    // Cleanup on node close
    node.on('close', async function (done) {
      if (redisClient) {
        try {
          await redisClient.quit();
          node.log('Disconnected from Redis/Valkey');
        } catch (err) {
          node.error('Error closing Redis connection: ' + err.message);
        }
      }
      done();
    });
  }

  RED.nodes.registerType('release-cluster-leader', ReleaseClusterLeaderNode);
};
