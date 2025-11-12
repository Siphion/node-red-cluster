/**
 * Cluster Leader Election Node for Node-RED
 * Implements distributed leader election using Redis/Valkey
 *
 * Output 1: Passes message only if this instance is the leader
 * Output 2: Passes message only if this instance is a follower
 */
const IoRedis = require('ioredis');
const { hostname: osHostname } = require('os');

module.exports = function (RED) {
  function ClusterLeaderNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Get configuration
    const valkeyConfig = RED.nodes.getNode(config.valkey);
    const lockKey = config.lockKey || 'nodered:leader';
    const lockTTL = parseInt(config.lockTTL) || 10;
    const hostname = process.env.HOSTNAME || osHostname();

    // Redis client setup
    let redisClient = null;
    let statusInterval = null;
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

        // Start status monitoring
        startStatusMonitoring();
      } catch (err) {
        node.error('Failed to connect to Redis: ' + err.message);
        node.status({ fill: 'red', shape: 'ring', text: 'connection failed' });
      }
    }

    // Check if current instance is the leader
    async function checkLeadership() {
      if (!isConnected || !redisClient) {
        return false;
      }

      try {
        // Try to acquire lock with TTL
        const result = await redisClient.set(lockKey, hostname, 'EX', lockTTL, 'NX');

        return result === 'OK';
      } catch (err) {
        node.error('Leader check failed: ' + err.message);
        return false;
      }
    }

    // Refresh leadership if already leader
    async function refreshLeadership() {
      if (!isConnected || !redisClient) {
        return false;
      }

      try {
        const currentLeader = await redisClient.get(lockKey);
        if (currentLeader === hostname) {
          // Refresh TTL if I'm still the leader
          await redisClient.expire(lockKey, lockTTL);
          return true;
        }
        return false;
      } catch (err) {
        node.error('Leader refresh failed: ' + err.message);
        return false;
      }
    }

    // Status monitoring with heartbeat
    function startStatusMonitoring() {
      if (statusInterval) {
        clearInterval(statusInterval);
      }

      statusInterval = setInterval(async () => {
        if (!isConnected) {
          node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
          return;
        }

        try {
          const currentLeader = await redisClient.get(lockKey);

          if (currentLeader === hostname) {
            // I'm the leader, refresh TTL
            await redisClient.expire(lockKey, lockTTL);
            node.status({
              fill: 'green',
              shape: 'dot',
              text: `leader (${hostname.substring(0, 12)})`,
            });
          } else if (currentLeader) {
            node.status({
              fill: 'yellow',
              shape: 'ring',
              text: `follower (leader: ${currentLeader.substring(0, 12)})`,
            });
          } else {
            node.status({
              fill: 'grey',
              shape: 'ring',
              text: 'no leader',
            });
          }
        } catch (err) {
          node.error('Status check failed: ' + err.message);
          node.status({ fill: 'red', shape: 'ring', text: 'error' });
        }
      }, 2000); // Check every 2 seconds
    }

    // Handle incoming messages
    node.on('input', async function (msg) {
      if (!isConnected) {
        node.warn('Not connected to Redis, dropping message');
        return;
      }

      try {
        // Try to become leader or refresh leadership
        let isLeader = await checkLeadership();

        if (!isLeader) {
          // Maybe I'm already the leader and just need to refresh
          isLeader = await refreshLeadership();
        }

        if (isLeader) {
          // I'm the leader - send to output 1
          msg.isLeader = true;
          msg.leaderHost = hostname;
          node.send([msg, null]);

          node.status({
            fill: 'green',
            shape: 'dot',
            text: `leader (${hostname.substring(0, 12)})`,
          });
        } else {
          // I'm a follower - send to output 2
          const currentLeader = await redisClient.get(lockKey);
          msg.isLeader = false;
          msg.leaderHost = currentLeader;
          msg.followerHost = hostname;
          node.send([null, msg]);

          node.status({
            fill: 'yellow',
            shape: 'ring',
            text: `follower (leader: ${currentLeader ? currentLeader.substring(0, 12) : 'unknown'})`,
          });
        }
      } catch (err) {
        node.error('Leader election failed: ' + err.message);
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      }
    });

    // Cleanup on node close
    node.on('close', async function (done) {
      if (statusInterval) {
        clearInterval(statusInterval);
      }

      if (redisClient && isConnected) {
        try {
          // Release leadership if I'm the leader
          const currentLeader = await redisClient.get(lockKey);
          if (currentLeader === hostname) {
            await redisClient.del(lockKey);
            node.log('Released leadership lock');
          }
          await redisClient.quit();
        } catch (err) {
          node.error('Error during cleanup: ' + err.message);
        }
      }
      done();
    });

    // Initialize
    initRedis();
  }

  RED.nodes.registerType('cluster-leader', ClusterLeaderNode);
};
