/**
 * Drive the server exactly the way Claude Desktop does: npx mcp-remote over
 * stdio, with the bearer token passed as a header.
 *
 * Reads the command out of Claude's own config rather than hardcoding it, so
 * this fails if the wizard ever writes something Claude cannot run — which is
 * precisely the failure it exists to catch. Hardcoding the command would have
 * hidden the { url } mistake instead of surfacing it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const configPath = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');

const entry = JSON.parse(readFileSync(configPath, 'utf8'))?.mcpServers?.['tag-copilot'];
if (!entry) {
    console.error('tag-copilot is not in Claude’s config — run the wizard’s "Add to Claude Desktop" first');
    process.exit(1);
}
if (!entry.command) {
    console.error('config has no command to run. Claude Desktop launches stdio servers; a bare { url } will not work.');
    process.exit(1);
}

const shown = entry.args.map((a) => (a.startsWith('Authorization') ? 'Authorization: Bearer <redacted>' : a));
console.log('running Claude’s own command:', entry.command, shown.join(' '));

const c = new Client({ name: 'claude-desktop-sim', version: '1.0.0' }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: entry.command, args: entry.args }));

const tools = await c.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const devices = JSON.parse((await c.callTool({ name: 'list_devices', arguments: {} })).content[0].text);
console.log('devices:', devices.map((d) => `${d.device} (${d.tags} tags)`).join(', '));

const first = devices[0].device;
const rows = JSON.parse((await c.callTool({ name: 'read_all', arguments: { device: first } })).content[0].text);
console.log(`${first}: ${rows.filter((r) => r.quality === 'good').length}/${rows.length} good`);

await c.close();
process.exit(0);
