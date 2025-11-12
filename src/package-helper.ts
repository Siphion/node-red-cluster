import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * PackageHelper
 * Handles npm package installation for Node-RED package synchronization
 */
export class PackageHelper {
  private readonly userDir: string;
  private readonly packageJsonPath: string;

  constructor(userDir: string) {
    this.userDir = userDir;
    this.packageJsonPath = path.join(userDir, 'package.json');
  }

  /**
   * Install npm packages and save to package.json
   * Uses --save flag to update package.json
   * Fails fast on any installation errors
   *
   * @param packages - Array of package names to install (e.g., ['node-red-dashboard', '@flowfuse/node-red-dashboard'])
   */
  async installPackages(packages: string[]): Promise<void> {
    if (!packages || packages.length === 0) {
      console.log('[ValkeyStorage] No packages to install');
      return;
    }

    console.log(`[ValkeyStorage] Installing ${packages.length} package(s): ${packages.join(', ')}`);

    return new Promise((resolve, reject) => {
      // Determine npm command (npm on Unix, npm.cmd on Windows)
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

      // Build arguments: install --save <packages>
      const args = ['install', '--save', ...packages];

      // Spawn npm process in userDir
      const npmProcess = spawn(npmCmd, args, {
        cwd: this.userDir,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored, stdout/stderr piped
        env: {
          ...process.env,
          // Ensure npm doesn't try to use interactive features
          CI: 'true',
        },
      });

      let stdout = '';
      let stderr = '';

      // Capture stdout
      npmProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        stdout += output;
        // Log npm output with prefix
        output.split('\n').forEach(line => {
          if (line.trim()) {
            console.log(`[ValkeyStorage] npm: ${line}`);
          }
        });
      });

      // Capture stderr
      npmProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        stderr += output;
        // Log npm errors with prefix
        output.split('\n').forEach(line => {
          if (line.trim()) {
            console.error(`[ValkeyStorage] npm: ${line}`);
          }
        });
      });

      // Handle process completion
      npmProcess.on('close', (code: number | null) => {
        if (code === 0) {
          console.log(`[ValkeyStorage] Successfully installed ${packages.length} package(s)`);
          resolve();
        } else {
          const error = new Error(
            `npm install failed with exit code ${code}\nPackages: ${packages.join(', ')}\nStderr: ${stderr}`
          );
          console.error('[ValkeyStorage] Package installation failed:', error.message);
          // Fail fast - throw error to crash the process
          reject(error);
        }
      });

      // Handle spawn errors (e.g., npm not found)
      npmProcess.on('error', (error: Error) => {
        console.error('[ValkeyStorage] Failed to spawn npm process:', error);
        reject(error);
      });
    });
  }

  /**
   * Uninstall npm packages and update package.json
   * Uses --save flag to update package.json
   * Fails fast on any uninstallation errors
   *
   * @param packages - Array of package names to uninstall (e.g., ['node-red-dashboard', '@flowfuse/node-red-dashboard'])
   */
  async uninstallPackages(packages: string[]): Promise<void> {
    if (!packages || packages.length === 0) {
      console.log('[ValkeyStorage] No packages to uninstall');
      return;
    }

    console.log(`[ValkeyStorage] Uninstalling ${packages.length} package(s): ${packages.join(', ')}`);

    return new Promise((resolve, reject) => {
      // Determine npm command (npm on Unix, npm.cmd on Windows)
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

      // Build arguments: uninstall --save <packages>
      const args = ['uninstall', '--save', ...packages];

      // Spawn npm process in userDir
      const npmProcess = spawn(npmCmd, args, {
        cwd: this.userDir,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored, stdout/stderr piped
        env: {
          ...process.env,
          // Ensure npm doesn't try to use interactive features
          CI: 'true',
        },
      });

      let stdout = '';
      let stderr = '';

      // Capture stdout
      npmProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        stdout += output;
        // Log npm output with prefix
        output.split('\n').forEach(line => {
          if (line.trim()) {
            console.log(`[ValkeyStorage] npm: ${line}`);
          }
        });
      });

      // Capture stderr
      npmProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        stderr += output;
        // Log npm errors with prefix
        output.split('\n').forEach(line => {
          if (line.trim()) {
            console.error(`[ValkeyStorage] npm: ${line}`);
          }
        });
      });

      // Handle process completion
      npmProcess.on('close', (code: number | null) => {
        if (code === 0) {
          console.log(`[ValkeyStorage] Successfully uninstalled ${packages.length} package(s)`);
          resolve();
        } else {
          const error = new Error(
            `npm uninstall failed with exit code ${code}\nPackages: ${packages.join(', ')}\nStderr: ${stderr}`
          );
          console.error('[ValkeyStorage] Package uninstallation failed:', error.message);
          // Fail fast - throw error to crash the process
          reject(error);
        }
      });

      // Handle spawn errors (e.g., npm not found)
      npmProcess.on('error', (error: Error) => {
        console.error('[ValkeyStorage] Failed to spawn npm process:', error);
        reject(error);
      });
    });
  }

  /**
   * Verify that userDir exists and is writable
   * Checks for package.json and node_modules directory
   */
  async verifyUserDir(): Promise<{ hasPackageJson: boolean; hasNodeModules: boolean }> {
    try {
      // Check if userDir exists
      await fs.access(this.userDir);

      // Check for package.json
      let hasPackageJson = false;
      try {
        await fs.access(this.packageJsonPath);
        hasPackageJson = true;
      } catch {
        // package.json doesn't exist
      }

      // Check for node_modules
      let hasNodeModules = false;
      const nodeModulesPath = path.join(this.userDir, 'node_modules');
      try {
        await fs.access(nodeModulesPath);
        hasNodeModules = true;
      } catch {
        // node_modules doesn't exist
      }

      return { hasPackageJson, hasNodeModules };
    } catch (error) {
      console.error('[ValkeyStorage] Error verifying userDir:', error);
      throw new Error(`UserDir ${this.userDir} is not accessible or does not exist`);
    }
  }

  /**
   * Get the user directory path
   */
  getUserDir(): string {
    return this.userDir;
  }
}
