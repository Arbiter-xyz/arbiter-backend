#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, fromEnv } from './server.js';

// stdout is the MCP protocol channel — anything human-readable goes to stderr.
const server = createServer(fromEnv());
await server.connect(new StdioServerTransport());
console.error('arbiter-mcp ready (stdio)');
