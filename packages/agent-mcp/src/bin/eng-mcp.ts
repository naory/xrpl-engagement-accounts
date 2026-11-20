#!/usr/bin/env node
// Packed entry for the agent MCP server. stdout is JSON-RPC only.
import { startAgentServer } from '../server.ts'

await startAgentServer()
