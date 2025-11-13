import { Redis, type RedisOptions } from 'ioredis';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PackageHelper } from './package-helper.js';
import type {
  ValkeyStorageConfig,
  NodeREDSettings,
  FlowConfig,
  CredentialsConfig,
  UserSettings,
  SessionsConfig,
  LibraryEntry,
  StorageModule,
  ProjectMetadata,
} from './types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Valkey/Redis storage module for Node-RED with pub/sub support
 */
export class ValkeyStorage implements StorageModule {
  public client!: Redis;
  private subscriber?: Redis;
  private config!: Required<ValkeyStorageConfig>;
  private packageHelper?: PackageHelper;
  private packageSubscriber?: Redis;
  private lastKnownPackages?: Record<string, string>;
  public localfilesystem?: any; // Public for git user sync in index.ts
  private runtime?: any; // Runtime reference for worker reload
  private packageSyncTimer?: NodeJS.Timeout; // Debounce timer for package sync

  // Lazy restore flags - restore from Redis on first access (worker only)
  private needsRestore = {
    flows: true,
    credentials: true,
    settings: true,
    sessions: true,
  };

  constructor() {
    // Properties initialized in init()
  }

  /**
   * Initialize storage connection
   */
  async init(settings: NodeREDSettings, runtime?: any): Promise<void> {
    // Save runtime reference for worker reload
    this.runtime = runtime;

    const userConfig = (settings.valkey || {}) as Partial<ValkeyStorageConfig>;

    // Validate required role field
    if (!userConfig.role || (userConfig.role !== 'admin' && userConfig.role !== 'worker')) {
      throw new Error('[ValkeyStorage] "role" field is required and must be either "admin" or "worker"');
    }

    // Extract storage-specific options with defaults
    const role = userConfig.role;
    const keyPrefix = userConfig.keyPrefix || 'nodered:';
    const updateChannel = userConfig.updateChannel || 'nodered:flows:updated';
    const enableCompression = userConfig.enableCompression || false;
    const sessionTTL = userConfig.sessionTTL || 86400;
    const syncPackages = userConfig.syncPackages !== false; // Default to true, can be disabled with syncPackages: false
    const packageChannel = userConfig.packageChannel || 'nodered:packages:updated';

    // Extract ioredis connection options (everything else)
    const userConfigAny = userConfig as any;
    const ioredisOptions: RedisOptions = {
      host: userConfigAny.host,
      port: userConfigAny.port,
      sentinels: userConfigAny.sentinels,
      name: userConfigAny.name,
      tls: userConfigAny.tls,
      // Add any other RedisOptions properties as needed
    };

    // Store complete config
    this.config = {
      role,
      keyPrefix,
      updateChannel,
      enableCompression,
      sessionTTL,
      syncPackages,
      packageChannel,
      ...ioredisOptions,
    } as any; // Type assertion needed due to optional RedisOptions properties

    // Pass ioredis options directly - let ioredis handle its own defaults
    const connectionConfig: RedisOptions = ioredisOptions;
    const hasAdvancedConfig = ioredisOptions.sentinels;

    // Create Redis client with all ioredis options
    this.client = new Redis({
      ...connectionConfig,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError: (err: Error) => {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
          return true;
        }
        return false;
      },
    });

    await this.client.ping();

    // Log connection info
    const connInfo = hasAdvancedConfig
      ? 'Redis (Sentinel mode)'
      : connectionConfig.host
        ? `${connectionConfig.host}:${connectionConfig.port || 6379}`
        : 'Redis (default connection)';
    console.log(`[ValkeyStorage] Connected to ${connInfo}`);

    // Initialize localfilesystem for both Admin and Worker nodes
    // Restore from Redis will happen lazily on first get() call
    if (settings.userDir && runtime) {
      try {
        // Dynamically resolve the localfilesystem module path
        const runtimePath = require.resolve('@node-red/runtime');
        const runtimeLibDir = require('path').dirname(runtimePath);
        const localfsPath = require('path').join(runtimeLibDir, 'storage/localfilesystem');

        console.log('[ValkeyStorage] Loading localfilesystem from:', localfsPath);
        this.localfilesystem = require(localfsPath);

        // Initialize localfilesystem - it will load existing files or start empty
        await this.localfilesystem.init(settings, runtime);

        console.log('[ValkeyStorage] LocalFileSystem initialized successfully');
      } catch (error) {
        console.error('[ValkeyStorage] Failed to initialize localfilesystem:', error);
        // Non-fatal - continue without localfilesystem support
        this.localfilesystem = undefined;
      }
    } else {
      if (!settings.userDir) {
        console.log('[ValkeyStorage] LocalFileSystem not available: settings.userDir is not set');
      } else if (!runtime) {
        console.log('[ValkeyStorage] LocalFileSystem not available: runtime parameter is missing');
      }
    }

    // localfilesystem.init() handles creation of required files when enabled

    // Admin: Sync existing flows and credentials to Redis on startup (if not already there)
    if (this.config.role === 'admin' && this.localfilesystem) {
      try {
        // Check if flows exist in Redis
        const flowsKey = this.getKey('flows');
        const flowsExist = await this.client.exists(flowsKey);

        if (!flowsExist) {
          // Read flows from disk and sync to Redis
          const flows = await this.localfilesystem.getFlows();
          if (flows && (Array.isArray(flows) ? flows.length > 0 : Object.keys(flows).length > 0)) {
            const data = await this.serialize(flows);
            await this.client.set(flowsKey, data);
            console.log('[ValkeyStorage] Admin: synced existing flows to Redis on startup');
          }
        }

        // Check if credentials exist in Redis
        const credsKey = this.getKey('credentials');
        const credsExist = await this.client.exists(credsKey);

        if (!credsExist) {
          // Read credentials from disk and sync to Redis (even if empty)
          const creds = await this.localfilesystem.getCredentials() || {};
          const data = await this.serialize(creds);
          await this.client.set(credsKey, data);
          console.log('[ValkeyStorage] Admin: synced existing credentials to Redis on startup');
        }
      } catch (error) {
        console.error('[ValkeyStorage] Error syncing existing data to Redis:', error);
        // Non-fatal - continue
      }
    }

    // Worker: Flows will be restored on first getFlows() call
    // We can't restore during init() because runtime is not fully initialized yet

    // Setup flow update subscription for worker nodes
    if (this.config.role === 'worker') {
      this.subscriber = this.client.duplicate();
      await this.subscriber.subscribe(this.config.updateChannel);

      this.subscriber.on('message', async (channel: string, message: string) => {
        if (channel === this.config.updateChannel) {
          console.log(`[ValkeyStorage] Flows updated at ${message}, reloading...`);

          try {
            // Worker reads from Redis on every getFlows() call
            // Just call loadFlows() to trigger reload without process restart
            if (this.runtime && this.runtime.nodes && this.runtime.nodes.loadFlows) {
              await this.runtime.nodes.loadFlows();
              console.log('[ValkeyStorage] Worker: flows reloaded successfully');
            } else {
              console.log('[ValkeyStorage] Worker: runtime.nodes.loadFlows not available, restarting process');
              process.exit(0);
            }
          } catch (error: any) {
            console.error('[ValkeyStorage] Worker: error reloading flows:', error.message || error);
            console.log('[ValkeyStorage] Falling back to process restart');
            process.exit(0);
          }
        }
      });

      console.log(`[ValkeyStorage] Subscribed to ${this.config.updateChannel}`);
    }

    // Initialize package synchronization
    if (this.config.syncPackages) {
      if (!settings.userDir) {
        throw new Error('[ValkeyStorage] syncPackages requires settings.userDir to be set');
      }

      // Initialize PackageHelper
      this.packageHelper = new PackageHelper(settings.userDir);
      console.log(`[ValkeyStorage] Package synchronization enabled, using ${settings.userDir}`);

      // Setup package subscriber for worker nodes
      if (this.config.role === 'worker') {
        this.packageSubscriber = this.client.duplicate();
        await this.packageSubscriber.subscribe(this.config.packageChannel);

        this.packageSubscriber.on('message', async (channel: string, message: string) => {
          if (channel === this.config.packageChannel) {
            try {
              console.log(`[ValkeyStorage] Package update notification received`);

              // Parse dependencies object from admin (name -> version)
              const adminDependencies: Record<string, string> = JSON.parse(message);

              // Read worker's current package.json to get installed packages
              const packageJsonPath = path.join(this.packageHelper!.getUserDir(), 'package.json');
              let workerDependencies: Record<string, string> = {};

              try {
                const packageContent = await fs.readFile(packageJsonPath, 'utf8');
                const packageJson = JSON.parse(packageContent);
                workerDependencies = packageJson.dependencies || {};

                console.log(`[ValkeyStorage] Worker has ${Object.keys(workerDependencies).length} packages installed`);
                console.log(`[ValkeyStorage] Admin has ${Object.keys(adminDependencies).length} packages`);
              } catch (error) {
                console.log('[ValkeyStorage] Worker package.json not found, assuming fresh install');
              }

              // Calculate diff
              const packagesToInstall: string[] = [];
              const packagesToUninstall: string[] = [];

              // Find packages to install or update (missing or version mismatch)
              for (const [pkg, version] of Object.entries(adminDependencies)) {
                if (!workerDependencies[pkg] || workerDependencies[pkg] !== version) {
                  // Install with specific version: package@version
                  packagesToInstall.push(`${pkg}@${version}`);
                }
              }

              // Find packages to uninstall (in worker but not in admin)
              for (const pkg of Object.keys(workerDependencies)) {
                if (!adminDependencies[pkg]) {
                  packagesToUninstall.push(pkg);
                }
              }

              console.log(`[ValkeyStorage] Packages to install: ${packagesToInstall.length}`);
              console.log(`[ValkeyStorage] Packages to uninstall: ${packagesToUninstall.length}`);

              // Uninstall packages first
              if (packagesToUninstall.length > 0) {
                console.log(`[ValkeyStorage] Uninstalling packages: ${packagesToUninstall.join(', ')}`);
                await this.packageHelper!.uninstallPackages(packagesToUninstall);
                console.log('[ValkeyStorage] Packages uninstalled, should be available to flows');
              }

              // Install new packages
              if (packagesToInstall.length > 0) {
                console.log(`[ValkeyStorage] Installing packages: ${packagesToInstall.join(', ')}`);
                await this.packageHelper!.installPackages(packagesToInstall);
                console.log('[ValkeyStorage] Packages installed, should be available to flows');
              }

              if (packagesToInstall.length === 0 && packagesToUninstall.length === 0) {
                console.log('[ValkeyStorage] No package changes needed');
              }
            } catch (error) {
              console.error('[ValkeyStorage] Error processing package update:', error);
              // Fail fast - exit with error code
              process.exit(1);
            }
          }
        });

        console.log(`[ValkeyStorage] Subscribed to package updates on ${this.config.packageChannel}`);

        // Sync packages on worker startup
        try {
          console.log('[ValkeyStorage] Worker startup: checking for package sync from Redis');

          // Try to get package list from Redis
          const packagesKey = 'nodered:packages';
          const packagesData = await this.client.get(packagesKey);

          if (packagesData) {
            const adminDependencies: Record<string, string> = JSON.parse(packagesData);
            console.log(`[ValkeyStorage] Found ${Object.keys(adminDependencies).length} packages in Redis`);

            // Read worker's current package.json to get installed packages
            const packageJsonPath = path.join(this.packageHelper!.getUserDir(), 'package.json');
            let workerDependencies: Record<string, string> = {};

            try {
              const packageContent = await fs.readFile(packageJsonPath, 'utf8');
              const packageJson = JSON.parse(packageContent);
              workerDependencies = packageJson.dependencies || {};

              console.log(`[ValkeyStorage] Worker has ${Object.keys(workerDependencies).length} packages installed`);
            } catch (error) {
              console.log('[ValkeyStorage] Worker package.json not found, assuming fresh install');
            }

            // Calculate diff
            const packagesToInstall: string[] = [];
            const packagesToUninstall: string[] = [];

            // Find packages to install or update (missing or version mismatch)
            for (const [pkg, version] of Object.entries(adminDependencies)) {
              if (!workerDependencies[pkg] || workerDependencies[pkg] !== version) {
                // Install with specific version: package@version
                packagesToInstall.push(`${pkg}@${version}`);
              }
            }

            // Find packages to uninstall (in worker but not in admin)
            for (const pkg of Object.keys(workerDependencies)) {
              if (!adminDependencies[pkg]) {
                packagesToUninstall.push(pkg);
              }
            }

            console.log(`[ValkeyStorage] Worker startup: ${packagesToInstall.length} to install, ${packagesToUninstall.length} to uninstall`);

            // Uninstall packages first
            if (packagesToUninstall.length > 0) {
              console.log(`[ValkeyStorage] Worker startup: uninstalling ${packagesToUninstall.join(', ')}`);
              await this.packageHelper!.uninstallPackages(packagesToUninstall);
            }

            // Install new packages
            if (packagesToInstall.length > 0) {
              console.log(`[ValkeyStorage] Worker startup: installing ${packagesToInstall.join(', ')}`);
              await this.packageHelper!.installPackages(packagesToInstall);
            }

            if (packagesToInstall.length === 0 && packagesToUninstall.length === 0) {
              console.log('[ValkeyStorage] Worker startup: packages already in sync');
            }
          } else {
            console.log('[ValkeyStorage] No package list found in Redis yet');
          }
        } catch (error) {
          console.error('[ValkeyStorage] Error syncing packages on worker startup:', error);
          // Non-fatal error, continue with startup
        }
      }

      // Load initial package state from Redis for admin nodes
      if (this.config.role === 'admin') {
        const packagesKey = 'nodered:packages';
        const packagesData = await this.client.get(packagesKey);

        if (packagesData) {
          try {
            this.lastKnownPackages = JSON.parse(packagesData);
            console.log(`[ValkeyStorage] Loaded ${Object.keys(this.lastKnownPackages || {}).length} existing packages from Redis`);
          } catch (error) {
            console.error('[ValkeyStorage] Error loading initial package state:', error);
            // Non-fatal - just start with empty state
            this.lastKnownPackages = {};
          }
        } else {
          this.lastKnownPackages = {};
        }
      }
    }

    // Note: We don't restore active project during init() because Node-RED's runtime
    // is not fully initialized yet (settings not available). The project metadata
    // is saved to Redis when a project is created/activated, but restoration is manual.
    // Flows are restored correctly regardless of project state.
  }


  /**
   * Restore active project from Redis on admin startup (OLD METHOD - kept for reference)
   * Uses Node-RED's Projects API to ensure proper project structure
   */
  private async restoreActiveProject(settings: NodeREDSettings): Promise<void> {
    console.log('[ValkeyStorage] restoreActiveProject() called');
    try {
      // Check if there's an active project in Redis
      const activeProjectKey = this.getKey('activeProject');
      const activeProjectData = await this.client.get(activeProjectKey);

      if (!activeProjectData) {
        console.log('[ValkeyStorage] No active project in Redis, skipping restore');
        return;
      }

      const projectMeta: ProjectMetadata = JSON.parse(activeProjectData);
      console.log(`[ValkeyStorage] Found active project "${projectMeta.name}" in Redis`);

      if (!this.localfilesystem?.projects) {
        console.warn('[ValkeyStorage] Projects API not available, cannot restore project');
        return;
      }

      // Check if project already exists
      try {
        const existingProject = await this.localfilesystem.projects.getProject(projectMeta.name);
        if (existingProject) {
          console.log(`[ValkeyStorage] Project "${projectMeta.name}" already exists locally`);
          // Project exists, activate it if not already active
          const currentActive = this.localfilesystem.projects.getActiveProject();
          if (!currentActive || currentActive.name !== projectMeta.name) {
            console.log(`[ValkeyStorage] Activating project "${projectMeta.name}"`);
            const adminUser = { username: 'admin', permissions: '*' };
            await this.localfilesystem.projects.setActiveProject(adminUser, projectMeta.name);
            console.log(`[ValkeyStorage] Project "${projectMeta.name}" activated successfully`);
          } else {
            console.log(`[ValkeyStorage] Project "${projectMeta.name}" is already active`);
          }
          return;
        }
      } catch (error) {
        // Project doesn't exist, we'll create it below
        console.log(`[ValkeyStorage] Project "${projectMeta.name}" not found locally, will be created`);
      }

      // Get flows from Redis to initialize the project
      const flowsKey = this.getKey('flows');
      const flowsData = await this.client.get(flowsKey);

      if (!flowsData) {
        console.warn('[ValkeyStorage] No flows in Redis, cannot create project');
        return;
      }

      const flowConfig: FlowConfig = await this.deserialize(flowsData);

      // Create project using Node-RED's Projects API
      // We create a minimal user object for the API call
      const adminUser = { username: 'admin', permissions: '*' };

      const projectConfig = {
        name: projectMeta.name,
        summary: 'Project restored from Redis',
        // Don't set files.flow - let Node-RED use default flow.json
        git: {
          remotes: {}
        }
      };

      console.log(`[ValkeyStorage] Creating project "${projectMeta.name}" using Projects API`);

      try {
        // Create the project - this will create all necessary files and git repo
        await this.localfilesystem.projects.createProject(adminUser, projectConfig);
        console.log(`[ValkeyStorage] Project created successfully`);

        // Activate the project immediately after creation
        await this.localfilesystem.projects.setActiveProject(adminUser, projectMeta.name);
        console.log(`[ValkeyStorage] Project "${projectMeta.name}" activated`);

        // Now write the flows to the project using saveFlows
        // The flows will be saved to the project's flow.json via localfilesystem
        // localfilesystem.saveFlows expects just the flows array, not the FlowConfig object
        await this.localfilesystem.saveFlows(flowConfig.flows);
        console.log(`[ValkeyStorage] Flows written to project`);

      } catch (createError: any) {
        console.error(`[ValkeyStorage] Error creating project: ${createError.message}`);
        // If creation fails, log but continue - Node-RED will work without projects
      }

    } catch (error) {
      console.error('[ValkeyStorage] Error restoring active project:', error);
      // Non-fatal - continue without project
    }
  }

  /**
   * Get flows from storage
   * Admin: reads from disk (persistent storage)
   * Worker: lazy restore from Redis, then reads from local cache
   */
  async getFlows(): Promise<FlowConfig> {
    if (this.config.role === 'admin') {
      // Admin: NEVER restore from Redis - disk is source of truth
      // Just delegate directly to localfilesystem
      if (this.localfilesystem) {
        const result = await this.localfilesystem.getFlows();
        console.log('[ValkeyStorage] Admin getFlows() from disk:', Array.isArray(result) ? `array[${result.length}]` : 'object');
        return result;
      }
    } else {
      // Worker: always read from Redis (no disk caching)
      const flowsKey = this.getKey('flows');
      const flowsData = await this.client.get(flowsKey);

      if (flowsData) {
        const flows = await this.deserialize<FlowConfig>(flowsData);

        // Check if we have an object with flows property (non-project mode)
        // Node-RED expects an array in non-project mode
        if (!Array.isArray(flows) && flows && typeof flows === 'object' && 'flows' in flows) {
          const flowsArray = (flows as any).flows;
          console.log('[ValkeyStorage] Worker getFlows() from Redis: extracted array[' + flowsArray.length + '] from object');
          return flowsArray;
        }

        // Already an array (project mode)
        console.log('[ValkeyStorage] Worker getFlows() from Redis:',
          Array.isArray(flows) ? `array[${flows.length}]` : `object with keys: ${Object.keys(flows).join(',')}`);
        return flows;
      }

      // No flows in Redis, return empty
      console.log('[ValkeyStorage] Worker: no flows in Redis, returning empty array');
      return [];
    }

    // Fallback if localfilesystem not available
    console.warn('[ValkeyStorage] localfilesystem not available, returning empty flows');
    return { flows: [], rev: '0' };
  }

  /**
   * Save flows to storage and optionally publish update
   * Wrapper pattern: delegate to localfilesystem, then sync to Redis, then publish
   * @param skipPublish - If true, skip publishing update event (used during lazy restore)
   */
  async saveFlows(flows: FlowConfig, skipPublish = false): Promise<void> {
    const sanitized = this.sanitizeFlows(flows);

    // 1. Delegate to localfilesystem (writes file + updates memory)
    if (this.localfilesystem) {
      // localfilesystem.saveFlows expects different formats:
      // - Array when there's an active project
      // - Object {flows: [], rev: '0'} when no active project
      const activeProject = this.localfilesystem.projects?.getActiveProject?.();
      const dataToSave = activeProject ? sanitized.flows : sanitized;

      await this.localfilesystem.saveFlows(dataToSave);
      console.log('[ValkeyStorage] Flows saved via localfilesystem');
    } else {
      console.warn('[ValkeyStorage] localfilesystem not available, skipping file write');
    }

    // 2. Sync to Redis (always to global key - active flow only)
    // Admin: sync current active flow to Redis for workers
    // Worker: should not normally save flows (read-only)
    const key = this.getKey('flows');
    const data = await this.serialize(sanitized);
    await this.client.set(key, data);
    console.log('[ValkeyStorage] Flows synced to Redis (active flow)');

    // 4. Publish update for worker nodes (admin only)
    if (this.config.role === 'admin' && !skipPublish) {
      await this.client.publish(this.config.updateChannel, Date.now().toString());
      console.log(`[ValkeyStorage] Published flow update to ${this.config.updateChannel}`);
    }
  }

  /**
   * Get credentials from storage
   * Admin: reads from disk (persistent storage)
   * Worker: lazy restore from Redis, then reads from local cache
   */
  async getCredentials(): Promise<CredentialsConfig> {
    if (this.config.role === 'admin') {
      // Admin: NEVER restore from Redis - disk is source of truth
      if (this.localfilesystem) {
        return (await this.localfilesystem.getCredentials()) || {};
      }
    } else {
      // Worker: always read from Redis (no disk caching)
      const credsKey = this.getKey('credentials');
      const credsData = await this.client.get(credsKey);

      if (credsData) {
        const creds = await this.deserialize<CredentialsConfig>(credsData);
        console.log('[ValkeyStorage] Worker getCredentials() from Redis:', JSON.stringify(creds).substring(0, 100));
        return creds;
      }

      console.log('[ValkeyStorage] Worker: no credentials in Redis, returning empty');
      return {};
    }

    // Fallback if localfilesystem not available
    console.warn('[ValkeyStorage] localfilesystem not available, returning empty credentials');
    return {};
  }

  /**
   * Save credentials to storage
   * Wrapper pattern: delegate to localfilesystem, then sync to Redis
   */
  async saveCredentials(credentials: CredentialsConfig): Promise<void> {
    // 1. Delegate to localfilesystem (writes file + updates memory)
    if (this.localfilesystem) {
      await this.localfilesystem.saveCredentials(credentials);
      console.log('[ValkeyStorage] Credentials saved via localfilesystem');
    } else {
      console.warn('[ValkeyStorage] localfilesystem not available, skipping file write');
    }

    // 2. Sync to Redis (always to global key - active credentials only)
    const key = this.getKey('credentials');
    const data = await this.serialize(credentials);
    await this.client.set(key, data);
    console.log('[ValkeyStorage] Credentials synced to Redis (active credentials)');
  }

  /**
   * Get user settings from storage
   * Admin: reads from disk (persistent storage)
   * Worker: lazy restore from Redis, then reads from local cache
   */
  async getSettings(): Promise<UserSettings> {
    if (this.config.role === 'admin') {
      // Admin: NEVER restore from Redis - disk is source of truth
      if (this.localfilesystem) {
        return await this.localfilesystem.getSettings();
      }
    } else {
      // Worker: always read from Redis (no disk caching)
      const settingsKey = this.getKey('settings');
      const settingsData = await this.client.get(settingsKey);

      if (settingsData) {
        const settings = await this.deserialize<UserSettings>(settingsData);
        console.log('[ValkeyStorage] Worker getSettings() from Redis');
        return settings;
      }

      console.log('[ValkeyStorage] Worker: no settings in Redis, returning empty');
      return {};
    }

    // Fallback if localfilesystem not available
    console.warn('[ValkeyStorage] localfilesystem not available, returning empty settings');
    return {};
  }

  /**
   * Save user settings to storage
   * Wrapper pattern: delegate to localfilesystem, then sync to Redis, then package sync
   */
  async saveSettings(settings: UserSettings): Promise<void> {
    // Validate input
    if (!settings || typeof settings !== 'object') {
      throw new Error('[ValkeyStorage] saveSettings: settings must be an object');
    }

    // 1. Delegate to localfilesystem (writes file + updates memory)
    if (this.localfilesystem) {
      await this.localfilesystem.saveSettings(settings);
      console.log('[ValkeyStorage] Settings saved via localfilesystem');
    } else {
      console.warn('[ValkeyStorage] localfilesystem not available, skipping file write');
    }

    // 2. Sync to Redis
    const key = this.getKey('settings');
    const data = await this.serialize(settings);
    await this.client.set(key, data);
    console.log('[ValkeyStorage] Settings synced to Redis');

    // 3. Package sync: debounced to wait for package.json update (admin only)
    if (this.config.syncPackages && this.config.role === 'admin') {
      // Clear existing timer if any
      if (this.packageSyncTimer) {
        clearTimeout(this.packageSyncTimer);
      }

      console.log('[ValkeyStorage] Scheduling package sync (debounced 500ms)...');

      // Schedule package sync after 500ms to allow package.json to be updated
      this.packageSyncTimer = setTimeout(() => {
        console.log('[ValkeyStorage] Running debounced package sync...');
        this.handlePackageSync(settings).catch(error => {
          console.error('[ValkeyStorage] Package sync failed:', error);
        });
      }, 500);
    } else {
      console.log('[ValkeyStorage] Package sync skipped: syncPackages=' + this.config.syncPackages + ', role=' + this.config.role);
    }
  }

  /**
   * Get sessions from storage
   * Admin: reads from disk (persistent storage)
   * Worker: lazy restore from Redis, then reads from local cache
   */
  async getSessions(): Promise<SessionsConfig> {
    if (this.config.role === 'admin') {
      // Admin: NEVER restore from Redis - disk is source of truth
      if (this.localfilesystem) {
        return (await this.localfilesystem.getSessions()) || {};
      }
    } else {
      // Worker: always read from Redis (no disk caching)
      const sessionsKey = this.getKey('sessions');
      const sessionsData = await this.client.get(sessionsKey);

      if (sessionsData) {
        const sessions = await this.deserialize<SessionsConfig>(sessionsData);
        console.log('[ValkeyStorage] Worker getSessions() from Redis');
        return sessions;
      }

      console.log('[ValkeyStorage] Worker: no sessions in Redis, returning empty');
      return {};
    }

    // Fallback if localfilesystem not available
    console.warn('[ValkeyStorage] localfilesystem not available, returning empty sessions');
    return {};
  }

  /**
   * Save sessions to storage with TTL
   */
  async saveSessions(sessions: SessionsConfig): Promise<void> {
    // 1. Delegate to localfilesystem (writes file + updates memory)
    if (this.localfilesystem) {
      await this.localfilesystem.saveSessions(sessions);
      console.log('[ValkeyStorage] Sessions saved via localfilesystem');
    } else {
      console.warn('[ValkeyStorage] localfilesystem not available, skipping file write');
    }

    // 2. Sync to Redis with TTL
    const key = this.getKey('sessions');
    const data = await this.serialize(sessions);
    await this.client.set(key, data, 'EX', this.config.sessionTTL);
    console.log('[ValkeyStorage] Sessions synced to Redis');
  }

  /**
   * Get library entry from storage
   */
  async getLibraryEntry(type: string, path: string): Promise<LibraryEntry | LibraryEntry[]> {
    const key = this.getLibraryKey(type, path);

    // Check if it's a directory listing
    if (path.endsWith('/') || !path) {
      const pattern = `${key}*`;
      const keys = await this.client.keys(pattern);

      const entries: LibraryEntry[] = [];
      for (const k of keys) {
        const data = await this.client.get(k);
        if (data) {
          const entry = await this.deserialize<LibraryEntry>(data);
          entries.push(entry);
        }
      }
      return entries;
    }

    // Get single entry
    const data = await this.client.get(key);
    if (!data) {
      throw new Error('Library entry not found');
    }

    return await this.deserialize<LibraryEntry>(data);
  }

  /**
   * Save library entry to storage
   */
  async saveLibraryEntry(
    type: string,
    path: string,
    meta: Record<string, any>,
    body: string
  ): Promise<void> {
    const key = this.getLibraryKey(type, path);
    const entry: LibraryEntry = { ...meta, fn: body };
    const data = await this.serialize(entry);

    await this.client.set(key, data);
  }

  /**
   * Ensure data is restored from Redis on first access (lazy restore)
   * Uses localfilesystem.save*() to update both filesystem and memory
   */
  private async ensureRestored(type: 'flows' | 'credentials' | 'settings' | 'sessions'): Promise<void> {
    // Skip if already restored or localfilesystem not available
    if (!this.needsRestore[type] || !this.localfilesystem) {
      return;
    }

    try {
      // Determine the correct Redis key based on active project
      const activeProject = this.localfilesystem.projects?.getActiveProject?.();
      let key: string;

      if (activeProject?.name && (type === 'flows' || type === 'credentials')) {
        // For flows/credentials with active project, use project-specific key
        key = this.getKey(`projects:${activeProject.name}:${type}`);
        console.log(`[ValkeyStorage] Restoring ${type} from project "${activeProject.name}"`);
      } else {
        // For settings/sessions, or flows/credentials without project, use global key
        key = this.getKey(type);
      }

      // Get data from Redis
      const dataFromRedis = await this.client.get(key);

      if (dataFromRedis) {
        const data = await this.deserialize(dataFromRedis);

        // For flows: check if there's an active project and use correct format
        if (type === 'flows') {
          const activeProject = this.localfilesystem.projects?.getActiveProject?.();
          let dataToSave: any = data;

          // If there's an active project, extract the array
          if (activeProject && data && typeof data === 'object' && 'flows' in data) {
            dataToSave = (data as any).flows;
            console.log(`[ValkeyStorage] Restoring flows for active project: extracted array of ${Array.isArray(dataToSave) ? dataToSave.length : 'unknown'} flows`);
          } else if (!activeProject) {
            // No active project: ensure we have object format
            if (Array.isArray(data)) {
              dataToSave = { flows: data, rev: '0' };
              console.log(`[ValkeyStorage] Restoring flows (no project): converting array to object format`);
            } else {
              console.log(`[ValkeyStorage] Restoring flows (no project): using object format with ${(data as any)?.flows?.length || 0} flows`);
            }
          }

          // Try to save flows
          try {
            await this.localfilesystem.saveFlows(dataToSave);
            const count = Array.isArray(dataToSave) ? dataToSave.length : (dataToSave?.flows?.length || 0);
            console.log(`[ValkeyStorage] Restored ${count} flows from Redis via localfilesystem`);
          } catch (saveError: any) {
            // If save fails (e.g., due to project state), just log and continue
            console.warn(`[ValkeyStorage] Could not save flows via localfilesystem: ${saveError.message}`);
            console.log('[ValkeyStorage] Flows will be loaded from Redis on next getFlows() call');
          }
        } else {
          // For other types (credentials, settings, sessions), restore normally
          const saveMethod =
            type === 'credentials' ? 'saveCredentials' :
            type === 'settings' ? 'saveSettings' : 'saveSessions';

          await this.localfilesystem[saveMethod](data);
          console.log(`[ValkeyStorage] Restored ${type} from Redis via localfilesystem`);
        }
      }
    } catch (error) {
      console.error(`[ValkeyStorage] Error restoring ${type} from Redis:`, error);
      // Non-fatal - continue with whatever localfilesystem has
    }

    // Mark as restored (don't try again)
    this.needsRestore[type] = false;
  }

  /**
   * Get full Redis key with prefix
   */
  public getKey(name: string): string {
    return `${this.config.keyPrefix}${name}`;
  }

  /**
   * Get library key with type and path
   */
  private getLibraryKey(type: string, path: string): string {
    return `${this.config.keyPrefix}library:${type}:${path}`;
  }

  /**
   * Sanitize and validate flows data
   * Filters out null/undefined flows and ensures valid structure
   * Handles both array format (no project) and object format (with project)
   */
  private sanitizeFlows(flowConfig: any): FlowConfig {
    if (!flowConfig || typeof flowConfig !== 'object') {
      console.warn('[ValkeyStorage] Invalid flow config, returning empty');
      return { flows: [], rev: '0' };
    }

    // Handle case where flowConfig is already an array (no active project)
    // localfilesystem returns array directly when not using projects
    if (Array.isArray(flowConfig)) {
      console.log('[ValkeyStorage] Flow config is array (no active project), converting to object format');
      return {
        flows: flowConfig.filter((flow: any) => {
          if (flow === null || flow === undefined) return false;
          if (typeof flow !== 'object') return false;
          if (!flow.id) return false;
          return true;
        }),
        rev: '0',
      };
    }

    // Handle object format (active project or Redis storage)
    let flows = flowConfig.flows;
    if (!Array.isArray(flows)) {
      console.warn('[ValkeyStorage] Flow config missing flows array, initializing empty');
      flows = [];
    }

    // Filter out null/undefined entries and validate each flow has an id
    const validFlows = flows.filter((flow: any) => {
      if (flow === null || flow === undefined) {
        console.warn('[ValkeyStorage] Filtered out null/undefined flow');
        return false;
      }
      if (typeof flow !== 'object') {
        console.warn('[ValkeyStorage] Filtered out non-object flow:', typeof flow);
        return false;
      }
      if (!flow.id) {
        console.warn('[ValkeyStorage] Filtered out flow without id:', flow);
        return false;
      }
      return true;
    });

    // Log if we filtered any flows
    if (validFlows.length !== flows.length) {
      console.warn(
        `[ValkeyStorage] Sanitized flows: ${flows.length} → ${validFlows.length} (removed ${flows.length - validFlows.length} invalid entries)`
      );
    }

    // Ensure rev property exists
    const rev = flowConfig.rev || '0';

    return {
      flows: validFlows,
      rev: rev,
    };
  }

  /**
   * Serialize data with optional compression
   */
  private async serialize(data: any): Promise<string> {
    const json = JSON.stringify(data);

    if (this.config.enableCompression && json.length > 1024) {
      const compressed = await gzipAsync(Buffer.from(json));
      return `gzip:${compressed.toString('base64')}`;
    }

    return json;
  }

  /**
   * Deserialize data with optional decompression
   */
  private async deserialize<T>(data: string): Promise<T> {
    if (data.startsWith('gzip:')) {
      const compressed = Buffer.from(data.substring(5), 'base64');
      const decompressed = await gunzipAsync(compressed);
      return JSON.parse(decompressed.toString());
    }

    return JSON.parse(data);
  }

  /**
   * Close connections (for cleanup)
   */
  async close(): Promise<void> {
    if (this.packageSubscriber) {
      await this.packageSubscriber.quit();
    }
    if (this.subscriber) {
      await this.subscriber.quit();
    }
    await this.client.quit();
  }

  /**
   * Handle package synchronization from .config.json changes
   * Throws errors to ensure data integrity - Node-RED needs to know if save fails
   */
  private async handlePackageSync(settings: UserSettings): Promise<void> {
    console.log('[ValkeyStorage] handlePackageSync called');

    try {
      // Read package.json to get installed modules
      if (!this.packageHelper) {
        console.log('[ValkeyStorage] No packageHelper available, skipping package sync');
        return;
      }

      const packageJsonPath = path.join(this.packageHelper.getUserDir(), 'package.json');
      console.log('[ValkeyStorage] Reading package.json from:', packageJsonPath);

      let packageJson: any;
      try {
        const packageContent = await fs.readFile(packageJsonPath, 'utf8');
        packageJson = JSON.parse(packageContent);
      } catch (error) {
        console.log('[ValkeyStorage] No package.json found, skipping package sync');
        return;
      }

      // Extract installed packages with versions from dependencies
      const dependencies: Record<string, string> = packageJson.dependencies || {};

      console.log('[ValkeyStorage] Found', Object.keys(dependencies).length, 'installed packages in package.json');
      console.log('[ValkeyStorage] Package list:', Object.keys(dependencies).join(', '));

      // Detect changes
      if (this.hasPackageChanges(dependencies)) {
        console.log('[ValkeyStorage] Package changes detected, publishing update...');

        // Publish dependencies object with versions
        await this.client.publish(this.config.packageChannel, JSON.stringify(dependencies));

        // Also save to Redis for worker startup sync
        const packagesKey = 'nodered:packages';
        await this.client.set(packagesKey, JSON.stringify(dependencies));

        console.log(`[ValkeyStorage] Published ${Object.keys(dependencies).length} package(s) with versions to ${this.config.packageChannel}`);
        console.log(`[ValkeyStorage] Saved ${Object.keys(dependencies).length} package(s) to Redis key: ${packagesKey}`);

        // Update known packages
        this.lastKnownPackages = dependencies;
      }
    } catch (error) {
      // Log detailed error for debugging
      console.error('[ValkeyStorage] Package sync failed:', error);
      console.error('[ValkeyStorage] Settings keys:', Object.keys(settings));

      // Re-throw with more context
      throw new Error(
        `Package synchronization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if package dependencies have changed from last known state
   * Compares both package names and versions
   */
  private hasPackageChanges(newPackages: Record<string, string>): boolean {
    // First run - always consider as changed
    if (!this.lastKnownPackages) {
      return true;
    }

    // Get package names
    const newPackageNames = Object.keys(newPackages);
    const oldPackageNames = Object.keys(this.lastKnownPackages);

    // Different count means changes occurred
    if (newPackageNames.length !== oldPackageNames.length) {
      return true;
    }

    // Check if all packages match (name and version)
    for (const [pkg, version] of Object.entries(newPackages)) {
      if (this.lastKnownPackages[pkg] !== version) {
        return true;
      }
    }

    return false;
  }

  /**
   * Expose Projects module if localfilesystem is initialized
   */
  get projects() {
    const projectsModule = this.localfilesystem?.projects;
    console.log('[ValkeyStorage] projects getter called, returning:', projectsModule ? 'projects module' : 'undefined');
    return projectsModule;
  }
}
