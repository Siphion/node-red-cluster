/**
 * Entry point for Node-RED context store
 * Exports factory function for creating ValkeyContext instances
 */
import { ValkeyContext } from './context.js';
import type { ValkeyContextConfig, ContextStore } from './types.js';

/**
 * Factory function for creating a ValkeyContext instance
 * This is the entry point called by Node-RED when loading the context store
 *
 * @param config - Configuration object
 * @returns A new ValkeyContext instance
 */
export default function (config: ValkeyContextConfig): ContextStore {
  return new ValkeyContext(config);
}

// Export for CommonJS (Node-RED compatibility)
module.exports = function (config: ValkeyContextConfig): ContextStore {
  return new ValkeyContext(config);
};
