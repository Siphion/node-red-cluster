import { Redis } from 'ioredis';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import stringify from 'json-stringify-safe';
import type { ValkeyContextConfig, ContextStore, PropertyPath } from './types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// Compression threshold: only compress values larger than 1KB
const COMPRESSION_THRESHOLD = 1024;
const COMPRESSION_PREFIX = 'gzip:';

/**
 * ValkeyContext - A Node-RED context store implementation using Valkey/Redis
 *
 * This implementation provides:
 * - Cluster-safe context storage (all data always stored in Redis/Valkey)
 * - Atomic operations for nested property updates using Lua scripts
 * - Optional compression for large values
 * - Support for Redis Sentinel for high availability
 * - Shared configuration with node-red-cluster storage
 */
export class ValkeyContext implements ContextStore {
  private client: Redis | null = null;
  private config: ValkeyContextConfig;
  private keyPrefix: string;
  private compressionEnabled: boolean;

  // Lua script for atomic set of nested properties
  private setNestedScript = `
    local key = KEYS[1]
    local path = ARGV[1]
    local value = ARGV[2]

    -- Get existing value or start with empty object
    local existing = redis.call('GET', key)
    local data = {}

    if existing then
      data = cjson.decode(existing)
    end

    -- Parse the path and navigate to the parent object
    local parts = {}
    for part in string.gmatch(path, "[^.]+") do
      table.insert(parts, part)
    end

    -- Navigate/create nested structure
    local current = data
    for i = 1, #parts - 1 do
      local part = parts[i]
      if type(current[part]) ~= "table" then
        current[part] = {}
      end
      current = current[part]
    end

    -- Set the final value
    local finalKey = parts[#parts]
    local decodedValue = cjson.decode(value)
    current[finalKey] = decodedValue

    -- Save back to Redis
    redis.call('SET', key, cjson.encode(data))
    return 1
  `;

  // Lua script for atomic delete of nested properties
  private deleteNestedScript = `
    local key = KEYS[1]
    local path = ARGV[1]

    local existing = redis.call('GET', key)
    if not existing then
      return 0
    end

    local data = cjson.decode(existing)

    -- Parse the path
    local parts = {}
    for part in string.gmatch(path, "[^.]+") do
      table.insert(parts, part)
    end

    -- Navigate to parent
    local current = data
    for i = 1, #parts - 1 do
      local part = parts[i]
      if type(current[part]) ~= "table" then
        return 0
      end
      current = current[part]
    end

    -- Delete the final key
    local finalKey = parts[#parts]
    current[finalKey] = nil

    -- Save back
    redis.call('SET', key, cjson.encode(data))
    return 1
  `;

  constructor(config: ValkeyContextConfig) {
    this.config = config;
    this.keyPrefix = config.keyPrefix || 'nodered:';
    this.compressionEnabled = config.enableCompression || false;

    // Ensure keyPrefix ends with colon
    if (!this.keyPrefix.endsWith(':')) {
      this.keyPrefix += ':';
    }
  }

  /**
   * Initialize the context store and establish Redis connection
   */
  async open(): Promise<void> {
    try {
      // Create Redis client with provided configuration
      this.client = new Redis({
        ...this.config,
        lazyConnect: true,
        retryStrategy: (times: number) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
      });

      // Connect to Redis
      await this.client.connect();

      // Verify connection with PING
      const pong = await this.client.ping();
      if (pong !== 'PONG') {
        throw new Error('Redis connection verification failed');
      }

      // Load Lua scripts
      await this.client.script('LOAD', this.setNestedScript);
      await this.client.script('LOAD', this.deleteNestedScript);

      console.log('[ClusterContext] Connected to Redis/Valkey successfully');
    } catch (error) {
      console.error('[ClusterContext] Failed to connect to Redis/Valkey:', error);
      throw error;
    }
  }

  /**
   * Close the Redis connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      console.log('[ClusterContext] Disconnected from Redis/Valkey');
    }
  }

  /**
   * Get one or more values from the context store
   */
  get(scope: string, key: string | string[], callback?: (err: Error | null, value?: any) => void): void {
    if (!this.client) {
      if (callback) callback(new Error('ValkeyContext not connected'));
      return;
    }

    const getOperation = async () => {
      try {
        if (Array.isArray(key)) {
          // Get multiple keys
          const values = await Promise.all(key.map((k: string) => this.getSingleValue(scope, k)));
          if (callback) callback(null, values);
        } else {
          // Get single key
          const value = await this.getSingleValue(scope, key);
          if (callback) callback(null, value);
        }
      } catch (error) {
        if (callback) callback(error as Error);
      }
    };

    getOperation();
  }

  /**
   * Set a value in the context store
   */
  set(scope: string, key: string, value: any, callback?: (err: Error | null) => void): void {
    if (!this.client) {
      if (callback) callback(new Error('ValkeyContext not connected'));
      return;
    }

    const setOperation = async () => {
      try {
        await this.setSingleValue(scope, key, value);
        if (callback) callback(null);
      } catch (error) {
        if (callback) callback(error as Error);
      }
    };

    setOperation();
  }

  /**
   * Get all keys for a given scope
   */
  keys(scope: string, callback: (err: Error | null, keys?: string[]) => void): void {
    if (!this.client) {
      callback(new Error('ValkeyContext not connected'));
      return;
    }

    const keysOperation = async () => {
      try {
        const pattern = this.buildKey(scope, '*');
        const redisKeys = await this.client!.keys(pattern);

        // Extract the key part (remove prefix and scope)
        const prefix = this.buildKey(scope, '');
        const contextKeys = redisKeys.map((k) => k.substring(prefix.length));

        callback(null, contextKeys);
      } catch (error) {
        callback(error as Error);
      }
    };

    keysOperation();
  }

  /**
   * Delete all data for a given scope
   */
  async delete(scope: string): Promise<void> {
    if (!this.client) {
      throw new Error('ValkeyContext not connected');
    }

    const pattern = this.buildKey(scope, '*');
    const keys = await this.client.keys(pattern);

    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }

  /**
   * Clean up context data for nodes that no longer exist
   */
  async clean(activeNodes: string[]): Promise<void> {
    if (!this.client) {
      throw new Error('ValkeyContext not connected');
    }

    // Get all node-scoped keys
    const pattern = this.buildKey('node:*', '');
    const allNodeKeys = await this.client.keys(pattern);

    // Extract node IDs from keys
    const activeNodeSet = new Set(activeNodes);
    const keysToDelete: string[] = [];

    for (const key of allNodeKeys) {
      // Extract node ID from key pattern: {prefix}context:node:{nodeId}:{key}
      const parts = key.split(':');
      if (parts.length >= 4 && parts[parts.length - 3] === 'node') {
        const nodeId = parts[parts.length - 2];
        if (!activeNodeSet.has(nodeId)) {
          keysToDelete.push(key);
        }
      }
    }

    // Delete keys for inactive nodes
    if (keysToDelete.length > 0) {
      await this.client.del(...keysToDelete);
      console.log(`[ClusterContext] Cleaned ${keysToDelete.length} keys for inactive nodes`);
    }
  }

  /**
   * Get a single value, handling nested properties
   */
  private async getSingleValue(scope: string, key: string): Promise<any> {
    const path = this.parsePath(key);
    const redisKey = this.buildKey(scope, path.parts[0]);

    let rawValue = await this.client!.get(redisKey);

    if (rawValue === null) {
      return undefined;
    }

    // Decompress if needed
    rawValue = await this.decompressIfNeeded(rawValue);

    // Parse JSON
    let value = JSON.parse(rawValue);

    // Navigate nested path if needed
    if (path.isNested) {
      for (let i = 1; i < path.parts.length; i++) {
        if (value === null || value === undefined) {
          return undefined;
        }
        value = value[path.parts[i]];
      }
    }

    return value;
  }

  /**
   * Set a single value, handling nested properties atomically
   */
  private async setSingleValue(scope: string, key: string, value: any): Promise<void> {
    const path = this.parsePath(key);
    const redisKey = this.buildKey(scope, path.parts[0]);

    // Serialize the value
    const serialized = stringify(value);

    if (path.isNested) {
      // Use Lua script for atomic nested update
      const nestedPath = path.parts.slice(1).join('.');
      await this.client!.eval(this.setNestedScript, 1, redisKey, nestedPath, serialized);
    } else {
      // Simple set for top-level keys
      let finalValue = serialized;

      // Compress if needed
      if (this.compressionEnabled && serialized.length > COMPRESSION_THRESHOLD) {
        const compressed = await gzipAsync(Buffer.from(serialized, 'utf8'));
        finalValue = COMPRESSION_PREFIX + compressed.toString('base64');
      }

      await this.client!.set(redisKey, finalValue);
    }
  }

  /**
   * Parse a property path into its components
   */
  private parsePath(key: string): PropertyPath {
    const parts = key.split('.');
    return {
      parts,
      isNested: parts.length > 1,
    };
  }

  /**
   * Build a Redis key from scope and property key
   */
  private buildKey(scope: string, key: string): string {
    return `${this.keyPrefix}context:${scope}:${key}`;
  }

  /**
   * Decompress a value if it was compressed
   */
  private async decompressIfNeeded(value: string): Promise<string> {
    if (value.startsWith(COMPRESSION_PREFIX)) {
      const compressed = value.substring(COMPRESSION_PREFIX.length);
      const buffer = Buffer.from(compressed, 'base64');
      const decompressed = await gunzipAsync(buffer);
      return decompressed.toString('utf8');
    }
    return value;
  }
}
