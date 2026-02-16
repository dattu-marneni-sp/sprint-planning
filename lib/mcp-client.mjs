/**
 * MCP Client - Manages connection to Atlassian MCP server
 * Provides request/response interface over stdio JSON-RPC
 */
import { spawn } from 'child_process';

const NPX_PATH = process.env.NPX_PATH || '/Users/dattu.marneni/.local/node-v22.13.1-darwin-arm64/bin/npx';
const NODE_BIN = '/Users/dattu.marneni/.local/node-v22.13.1-darwin-arm64/bin';

export class MCPClient {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.pendingRequests = new Map();
    this.reqId = 1;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.child = spawn(NPX_PATH, ['mcp-remote', 'https://mcp.atlassian.com/v1/sse'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin`
        }
      });

      this.child.stdout.on('data', (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id && this.pendingRequests.has(msg.id)) {
              this.pendingRequests.get(msg.id)(msg);
              this.pendingRequests.delete(msg.id);
            }
          } catch {}
        }
      });

      this.child.stderr.on('data', () => {});

      this.child.on('error', (err) => reject(err));

      const initMsg = JSON.stringify({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'sprint-planner', version: '1.0.0' }
        }
      });
      this.child.stdin.write(initMsg + '\n');

      setTimeout(() => {
        this.child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
        );
        resolve();
      }, 5000);
    });
  }

  async call(toolName, args) {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout calling ${toolName}`));
      }, 30000);

      this.pendingRequests.set(id, (msg) => {
        clearTimeout(timeout);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      });

      const rpc = JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: toolName, arguments: args }
      });
      this.child.stdin.write(rpc + '\n');
    });
  }

  extractText(result) {
    if (!result || !result.content) return null;
    for (const c of result.content) {
      if (c.text) return c.text;
    }
    return null;
  }

  extractJSON(result) {
    const text = this.extractText(result);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  disconnect() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
