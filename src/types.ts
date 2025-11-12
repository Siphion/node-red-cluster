import type { RedisOptions } from 'ioredis';

/**
 * Valkey Context Store Configuration
 * Used by Node-RED context storage API
 */
export interface ValkeyContextConfig extends RedisOptions {
  /**
   * Redis/Valkey key prefix for all context keys
   * @default "nodered:"
   */
  keyPrefix?: string;

  /**
   * Enable compression for large context values (>1KB)
   * @default false
   */
  enableCompression?: boolean;

  /**
   * Operation timeout in milliseconds
   * @default 5000
   */
  timeout?: number;
}

/**
 * Property path structure for nested context properties
 */
export interface PropertyPath {
  parts: string[];
  isNested: boolean;
}

/**
 * Node-RED Context Store API interface
 */
export interface ContextStore {
  /**
   * Initialize the context store
   */
  open(): Promise<void>;

  /**
   * Close the context store
   */
  close(): Promise<void>;

  /**
   * Get one or more values from the context store
   */
  get(scope: string, key: string | string[], callback?: (err: Error | null, value?: any) => void): void;

  /**
   * Set a value in the context store
   */
  set(scope: string, key: string, value: any, callback?: (err: Error | null) => void): void;

  /**
   * Get all keys for a given scope
   */
  keys(scope: string, callback: (err: Error | null, keys?: string[]) => void): void;

  /**
   * Delete all data for a given scope
   */
  delete(scope: string): Promise<void>;

  /**
   * Clean up context data for nodes that no longer exist (optional)
   */
  clean?(activeNodes: string[]): Promise<void>;
}

/**
 * Valkey Storage Configuration
 * Includes all RedisOptions to support all connection modes:
 * - Single instance: { host, port }
 * - Sentinel: { sentinels: [...], name: 'mymaster' }
 * - Cluster: { cluster: [...] }
 * - TLS: { tls: {...} }
 */
export interface ValkeyStorageConfig {
  /**
   * Node role: 'admin' or 'worker'
   * - admin: Uses projects, publishes flow updates, can install packages
   * - worker: No projects (flows.json only), subscribes to flow updates, auto-restarts
   * @required
   */
  role: 'admin' | 'worker';

  /**
   * Redis/Valkey key prefix for all storage keys
   * @default "nodered:"
   */
  keyPrefix?: string;

  /**
   * Pub/sub channel name for flow updates
   * @default "nodered:flows:updated"
   */
  updateChannel?: string;

  /**
   * Enable compression for large flows/credentials
   * @default false
   */
  enableCompression?: boolean;

  /**
   * TTL for sessions in seconds
   * @default 86400 (24 hours)
   */
  sessionTTL?: number;

  /**
   * Enable package synchronization from Admin to Worker nodes
   * When enabled, .config.json changes are stored in Redis
   * @default false
   */
  syncPackages?: boolean;

  /**
   * Pub/sub channel name for package updates
   * @default "nodered:packages:updated"
   */
  packageChannel?: string;
}

export interface NodeREDSettings {
  valkey?: ValkeyStorageConfig;
  userDir?: string;
  [key: string]: any;
}

export interface FlowConfig {
  flows?: any[];
  rev?: string;
  [key: string]: any;
}

export interface CredentialsConfig {
  [nodeId: string]: any;
}

export interface UserSettings {
  [key: string]: any;
}

export interface SessionsConfig {
  [sessionId: string]: any;
}

export interface LibraryEntry {
  fn?: string;
  [key: string]: any;
}

/**
 * Project metadata stored in Redis
 */
export interface ProjectMetadata {
  /**
   * Name of the active project
   */
  name: string;
  /**
   * Timestamp of last update
   */
  updated?: number;
}

/**
 * Node-RED Storage API interface
 * @see https://nodered.org/docs/api/storage/methods/
 */
export interface StorageModule {
  /**
   * Initialize the storage system
   */
  init(settings: NodeREDSettings): Promise<void>;

  /**
   * Get the runtime flow configuration
   */
  getFlows(): Promise<FlowConfig>;

  /**
   * Save the runtime flow configuration
   */
  saveFlows(flows: FlowConfig): Promise<void>;

  /**
   * Get the runtime flow credentials
   */
  getCredentials(): Promise<CredentialsConfig>;

  /**
   * Save the runtime flow credentials
   */
  saveCredentials(credentials: CredentialsConfig): Promise<void>;

  /**
   * Get the user settings
   */
  getSettings(): Promise<UserSettings>;

  /**
   * Save the user settings
   */
  saveSettings(settings: UserSettings): Promise<void>;

  /**
   * Get the sessions object
   */
  getSessions(): Promise<SessionsConfig>;

  /**
   * Save the sessions object
   */
  saveSessions(sessions: SessionsConfig): Promise<void>;

  /**
   * Get a library entry
   * @param type - Entry type ('flows', 'functions', etc.)
   * @param path - Entry pathname
   */
  getLibraryEntry(type: string, path: string): Promise<LibraryEntry | LibraryEntry[]>;

  /**
   * Save a library entry
   * @param type - Entry type
   * @param path - Entry pathname
   * @param meta - Entry metadata
   * @param body - Entry content
   */
  saveLibraryEntry(
    type: string,
    path: string,
    meta: Record<string, any>,
    body: string
  ): Promise<void>;
}
