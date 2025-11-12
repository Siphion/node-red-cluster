import { ValkeyStorage } from './storage.js';
import { PackageHelper } from './package-helper.js';
import { ValkeyContext } from './context.js';

export { ValkeyStorage, PackageHelper, ValkeyContext };
export * from './types.js';

// Create singleton instance
const storage = new ValkeyStorage();

// Projects proxy - forwards all calls to the real module after init
// We use a Proxy to handle the case where Node-RED copies the reference before init()
let realProjectsModule: any = null;
let localfilesystemModule: any = null;

const projectsProxy = new Proxy(
  {},
  {
    get(target, prop) {
      // If Projects module failed to initialize, return safe defaults
      if (!realProjectsModule) {
        console.warn(`[ValkeyStorage] Projects not available - method "${String(prop)}" called but module not initialized`);

        // Return safe defaults for common methods
        if (prop === 'getActiveProject') {
          return () => null;
        }
        if (prop === 'flowFileExists') {
          return () => false;
        }

        // For other methods, return a function that returns empty object
        return () => ({});
      }


      // Get the original property/method
      const originalValue = realProjectsModule[prop];

      // If it's a function, wrap it to handle errors gracefully
      if (typeof originalValue === 'function') {
        return (...args: any[]) => {
          try {
            const result = originalValue.apply(realProjectsModule, args);

            // If it's a Promise, handle async result
            if (result && typeof result.then === 'function') {
              return result.catch((error: any) => {
                console.error(`[ValkeyStorage] Error in async projects.${String(prop)}:`, error.message);
                throw error; // Re-throw to let Node-RED handle it
              });
            }

            return result;
          } catch (error: any) {
            console.error(`[ValkeyStorage] Error calling projects.${String(prop)}:`, error.message);
            throw error; // Re-throw to let Node-RED handle it
          }
        };
      }

      return originalValue;
    },
    has(target, prop) {
      // Return true to indicate properties exist (for hasOwnProperty checks)
      return realProjectsModule ? prop in realProjectsModule : false;
    },
  }
);

// Export plain object with methods as own properties for Node-RED compatibility
// Node-RED uses hasOwnProperty() to check method existence, which doesn't work with class instances
const storageModule: any = {
  init: async (settings: any, runtime: any) => {
    await storage.init(settings, runtime);

    // Populate the real projects module reference and localfilesystem reference
    if (storage.projects) {
      realProjectsModule = storage.projects;
      localfilesystemModule = storage.localfilesystem;
      console.log('[ValkeyStorage] Projects module loaded and ready');
    } else {
      console.log('[ValkeyStorage] Projects module not available');
    }
  },
  getFlows: () => storage.getFlows(),
  saveFlows: (flows: any) => storage.saveFlows(flows),
  getCredentials: () => storage.getCredentials(),
  saveCredentials: (credentials: any) => storage.saveCredentials(credentials),
  getSettings: () => storage.getSettings(),
  saveSettings: async (settings: any) => {
    await storage.saveSettings(settings);
  },
  getSessions: () => storage.getSessions(),
  saveSessions: (sessions: any) => storage.saveSessions(sessions),
  getLibraryEntry: (type: string, path: string) => storage.getLibraryEntry(type, path),
  saveLibraryEntry: (type: string, path: string, meta: Record<string, any>, body: string) =>
    storage.saveLibraryEntry(type, path, meta, body),

  // Expose projects proxy - Node-RED will copy this reference before init()
  // The proxy will forward all calls to the real module after init
  projects: projectsProxy,
};

// Export as default for ESM
export default storageModule;

// Export for CommonJS (Node-RED compatibility)
module.exports = storageModule;
