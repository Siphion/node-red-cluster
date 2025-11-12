import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { FlowConfig } from './types.js';

/**
 * FileSystemHelper
 * Handles file system operations for Node-RED projects support
 * Writes flows to disk in the format expected by Node-RED projects
 */
export class FileSystemHelper {
  private readonly flowsFile: string;
  private readonly backupFile: string;

  constructor(userDir: string) {
    this.flowsFile = path.join(userDir, 'flows.json');
    this.backupFile = path.join(userDir, 'flows.json.backup');
  }

  /**
   * Generate a revision hash from flow content
   * Uses SHA256 hash for consistency across instances
   */
  private generateRev(flows: any[]): string {
    const content = JSON.stringify(flows);
    return createHash('sha256').update(content).digest('hex').substring(0, 12);
  }

  /**
   * Save flows to file system
   * Creates backup of existing file before overwriting
   * @param flowConfig - Flow configuration (can be array or object with rev)
   */
  async saveFlowsToFile(flowConfig: FlowConfig): Promise<string> {
    try {
      // Extract flows array from config
      const flows = Array.isArray(flowConfig) ? flowConfig : (flowConfig.flows || []);

      // Generate revision hash
      const rev = this.generateRev(flows);

      // Create flow object with rev property for projects
      const flowData = {
        rev,
        flows
      };

      // Create backup of existing file if it exists
      try {
        await fs.access(this.flowsFile);
        await fs.copyFile(this.flowsFile, this.backupFile);
      } catch (err) {
        // File doesn't exist, no backup needed
      }

      // Write flows with indentation (format expected by projects)
      const content = JSON.stringify(flowData, null, 4);
      await fs.writeFile(this.flowsFile, content, 'utf8');

      console.log(`[ValkeyStorage] Flows written to ${this.flowsFile}`);
      return rev;
    } catch (error) {
      console.error('[ValkeyStorage] Error writing flows to file:', error);
      throw error;
    }
  }

  /**
   * Read flows from file system
   * Used as fallback when Redis is empty on virgin installation
   */
  async getFlowsFromFile(): Promise<FlowConfig | null> {
    try {
      await fs.access(this.flowsFile);
      const content = await fs.readFile(this.flowsFile, 'utf8');
      const flowData = JSON.parse(content);

      console.log(`[ValkeyStorage] Flows loaded from ${this.flowsFile}`);

      // Return in Node-RED format (with rev if present)
      if (flowData.flows && Array.isArray(flowData.flows)) {
        return {
          flows: flowData.flows,
          rev: flowData.rev
        };
      }

      // Handle legacy format (plain array)
      if (Array.isArray(flowData)) {
        return {
          flows: flowData
        };
      }

      return flowData;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist
        return null;
      }
      console.error('[ValkeyStorage] Error reading flows from file:', error);
      throw error;
    }
  }

  /**
   * Check if flows file exists
   */
  async flowsFileExists(): Promise<boolean> {
    try {
      await fs.access(this.flowsFile);
      return true;
    } catch {
      return false;
    }
  }
}
