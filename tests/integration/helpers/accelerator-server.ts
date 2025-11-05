/**
 * Accelerator Server Helper
 * Manages the Accelerator dev server for integration testing
 */

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';

interface AcceleratorServerOptions {
  port?: number;
  logOutput?: boolean;
}

export class AcceleratorServer {
  private process: ChildProcess | null = null;
  private port: number;
  private logOutput: boolean;
  private acceleratorPath: string;
  public ready: Promise<void>;
  private readyResolver?: () => void;
  private isExternalServer: boolean = false; // Track if server was already running

  constructor(options: AcceleratorServerOptions = {}) {
    this.port = options.port || 8787; // Wrangler's default dev port
    this.logOutput = options.logOutput ?? false;
    // Path to accelerator directory (sibling to connect)
    this.acceleratorPath = join(__dirname, '../../../../accelerator');

    this.ready = new Promise((resolve) => {
      this.readyResolver = resolve;
    });
  }

  /**
   * Check if Accelerator is already running on the configured port
   */
  private async checkServerRunning(): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${this.port}`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });

      if (response.ok) {
        const data = await response.json();
        // Check if it's actually the Accelerator server
        return data.name === 'Muhkoo Accelerator';
      }
    } catch {
      // Server not running or not responding
    }
    return false;
  }

  /**
   * Start the Accelerator dev server (or use existing one)
   */
  async start(): Promise<void> {
    // Check if server is already running
    const isRunning = await this.checkServerRunning();

    if (isRunning) {
      console.log(`✓ Found Accelerator already running on port ${this.port}`);
      console.log('  Using existing server for tests');
      this.isExternalServer = true;

      // Resolve ready immediately
      if (this.readyResolver) {
        this.readyResolver();
        this.readyResolver = undefined;
      }
      return;
    }

    if (this.process) {
      throw new Error('Accelerator server is already running');
    }

    // Check if accelerator directory exists
    const fs = await import('fs');
    if (!fs.existsSync(this.acceleratorPath)) {
      throw new Error(
        `Accelerator directory not found at: ${this.acceleratorPath}\n` +
        'Please ensure Accelerator is in the parent directory (../accelerator)'
      );
    }

    console.log(`Starting Accelerator dev server on port ${this.port}...`);
    console.log(`Accelerator path: ${this.acceleratorPath}`);

    // Start wrangler dev in the accelerator directory
    this.process = spawn('yarn', ['dev', '--port', String(this.port)], {
      cwd: this.acceleratorPath,
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
      stdio: this.logOutput ? 'inherit' : 'pipe',
    });

    // Capture output to detect when server is ready
    if (this.process.stdout) {
      this.process.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        if (this.logOutput) {
          console.log('[Accelerator]', output);
        }

        // Wrangler typically outputs "Ready on http://..." when ready
        if (output.includes('Ready on') || output.includes(`localhost:${this.port}`)) {
          if (this.readyResolver) {
            this.readyResolver();
            this.readyResolver = undefined;
          }
        }
      });
    }

    // Collect error output for diagnostics
    let errorOutput = '';

    if (this.process.stderr) {
      this.process.stderr.on('data', (data: Buffer) => {
        const output = data.toString();
        errorOutput += output;
        if (this.logOutput) {
          console.error('[Accelerator Error]', output);
        }
      });
    }

    this.process.on('error', (error) => {
      console.error('Failed to start Accelerator server:', error);
      console.error('Error output:', errorOutput);
    });

    this.process.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Accelerator server exited with code ${code}`);
        console.error('Error output:', errorOutput);
      } else {
        console.log(`Accelerator server exited with code ${code}`);
      }
      this.process = null;
    });

    // Wait for server to be ready (with timeout)
    await Promise.race([
      this.ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Accelerator server start timeout')), 30000)
      ),
    ]);

    // Give it a bit more time to fully initialize
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log(`Accelerator dev server ready at http://localhost:${this.port}`);
  }

  /**
   * Stop the Accelerator dev server (only if we started it)
   */
  async stop(): Promise<void> {
    // Don't stop external servers
    if (this.isExternalServer) {
      console.log('✓ Leaving external Accelerator server running');
      return;
    }

    if (!this.process) {
      return;
    }

    console.log('Stopping Accelerator dev server...');

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      this.process.on('exit', () => {
        this.process = null;
        console.log('Accelerator dev server stopped');
        resolve();
      });

      // Try graceful shutdown first
      this.process.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  /**
   * Get the base URL for the Accelerator server
   */
  getBaseUrl(): string {
    return `http://localhost:${this.port}`;
  }

  /**
   * Get the WebSocket URL for the Accelerator server
   */
  getWebSocketUrl(): string {
    return `ws://localhost:${this.port}`;
  }

  /**
   * Check if the server is running (either our process or external)
   */
  isRunning(): boolean {
    return this.process !== null || this.isExternalServer;
  }
}
