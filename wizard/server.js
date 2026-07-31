#!/usr/bin/env node
/**
 * The setup wizard: device -> tag map -> validated -> MCP config.
 *
 * Runs on the integrator's laptop, on the plant network. Nothing is sent
 * anywhere: the device is on a LAN a cloud service could never reach anyway, and
 * process data leaving site is the objection that ends OT security reviews.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { importCsv } = require('../lib/importer');
const { check, testConnection } = require('../lib/checker');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = path.join(ROOT, 'profiles');
const PORT = Number(process.env.WIZARD_PORT || 3000);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/csv', limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/test-connection', async (req, res) => {
    const { host, port, unitId } = req.body;
    if (!host) return res.status(400).json({ ok: false, detail: 'host is required' });
    res.json(await testConnection(host, port || 502, unitId || 1));
});

app.post('/api/import', (req, res) => {
    try {
        const { csv, device } = req.body;
        if (!csv || !csv.trim()) return res.status(400).json({ error: 'no CSV content' });
        const result = importCsv(csv, device || {});

        const slug = (device?.name || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const file = path.join(PROFILES, `${slug}.yaml`);
        fs.mkdirSync(PROFILES, { recursive: true });
        fs.writeFileSync(file, yaml.dump(result.profile, { lineWidth: 100, noRefs: true }));

        res.json({ ...result, profile: undefined, file: path.relative(ROOT, file) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/validate', async (req, res) => {
    try {
        const { file, samples, interval } = req.body;
        const abs = path.resolve(ROOT, file);
        if (!abs.startsWith(PROFILES)) return res.status(400).json({ error: 'profile must live in profiles/' });
        res.json(await check(abs, { samples: Number(samples) || 6, interval: Number(interval) || 900 }));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/**
 * Generate the reader flow for a device and deploy it into the running Node-RED.
 *
 * Only this device's tab is replaced — other flows are read back and preserved,
 * because deploying a full flow set that silently dropped someone else's work
 * would be unforgivable on a machine doing real commissioning.
 */
app.post('/api/deploy', async (req, res) => {
    try {
        const { file, pollSeconds } = req.body;
        const abs = path.resolve(ROOT, file);
        if (!abs.startsWith(PROFILES)) return res.status(400).json({ error: 'profile must live in profiles/' });

        const profile = yaml.load(fs.readFileSync(abs, 'utf8'));
        const rel = path.relative(ROOT, abs);
        const { generate } = require('../lib/flowgen');
        const { nodes, tabId, blocks } = generate(profile, rel, { pollSeconds: Number(pollSeconds) || 2 });

        const base = process.env.NODERED_URL || 'http://127.0.0.1:1880';
        let existing;
        try {
            const r = await fetch(`${base}/flows`);
            if (!r.ok) throw new Error(`Node-RED returned ${r.status}`);
            existing = await r.json();
        } catch (err) {
            return res.status(502).json({ error: `Could not reach Node-RED at ${base}: ${err.message}` });
        }

        // Drop this device's previous tab and everything on it; keep the rest.
        const ourIds = new Set(nodes.map((n) => n.id));
        const kept = existing.filter((n) => n.id !== tabId && n.z !== tabId && !ourIds.has(n.id));
        const merged = [...kept, ...nodes];

        const post = await fetch(`${base}/flows`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'Node-RED-Deployment-Type': 'full' },
            body: JSON.stringify(merged),
        });
        if (!post.ok) {
            return res.status(502).json({ error: `Deploy rejected: ${post.status} ${await post.text()}` });
        }

        res.json({
            ok: true, device: profile.device.name, blocks,
            tags: profile.tags.length,
            replaced: existing.filter((n) => n.z === tabId).length,
            mcp: `${base}/mcp`,
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

/** Where Claude Desktop keeps its config, per platform. */
function claudeConfigPath() {
    const home = require('os').homedir();
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

app.get('/api/claude-status', (_req, res) => {
    const file = claudeConfigPath();
    const exists = fs.existsSync(file);
    let installed = false;
    if (exists) {
        try {
            installed = Boolean(JSON.parse(fs.readFileSync(file, 'utf8'))?.mcpServers?.['modbus-copilot']);
        } catch { /* unreadable config is reported as not installed */ }
    }
    res.json({ file, exists, installed, platform: process.platform });
});

/**
 * Add the server to Claude Desktop's config in place.
 *
 * Merges rather than overwrites, and backs the file up first — this is somebody
 * else's application config, and clobbering their other MCP servers to save them
 * a copy-paste would be a poor trade.
 */
app.post('/api/add-to-claude', (req, res) => {
    const file = claudeConfigPath();
    const url = req.body?.url || `${process.env.NODERED_URL || 'http://127.0.0.1:1880'}/mcp`;
    try {
        let config = {};
        let backup = null;
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf8');
            try {
                config = JSON.parse(raw);
            } catch (err) {
                return res.status(400).json({
                    error: `Claude's config exists but is not valid JSON (${err.message}). Not touching it — fix or move ${file} first.`,
                });
            }
            backup = `${file}.bak-${Date.now()}`;
            fs.writeFileSync(backup, raw);
        } else {
            fs.mkdirSync(path.dirname(file), { recursive: true });
        }

        config.mcpServers = config.mcpServers || {};
        const existed = Boolean(config.mcpServers['modbus-copilot']);
        // Claude Desktop's mcpServers block launches stdio servers — it has no way
        // to start a bare { url }, which simply errors. mcp-remote is the standard
        // bridge: it speaks stdio to Claude and streamable HTTP to us.
        // mcp-remote passes a bearer token through with --header. Without a token
        // the endpoint is unauthenticated, which is fine only while it is bound to
        // localhost — see the warning tag-mcp logs at startup.
        const token = (process.env.MODBUS_COPILOT_TOKEN || '').trim();
        const args = ['-y', 'mcp-remote', url, '--allow-http'];
        if (token) args.push('--header', `Authorization: Bearer ${token}`);
        config.mcpServers['modbus-copilot'] = { command: 'npx', args };
        fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');

        res.json({
            ok: true, file, backup, url, replaced: existed,
            others: Object.keys(config.mcpServers).filter((k) => k !== 'modbus-copilot'),
            note: 'Restart Claude Desktop to pick it up.',
        });
    } catch (err) {
        res.status(500).json({ error: `${err.message} (config path: ${file})` });
    }
});

app.get('/api/auth-status', (_req, res) => {
    const token = (process.env.MODBUS_COPILOT_TOKEN || '').trim();
    res.json({
        authenticated: Boolean(token),
        // Never return the token itself — this endpoint is only as trustworthy as
        // whatever can reach the wizard.
        hint: token ? `set, ${token.length} chars` : null,
        safe_to_expose: Boolean(token),
        note: token
            ? 'Requests must carry Authorization: Bearer <token>.'
            : 'No token set. Safe on localhost; do not expose through a tunnel until one is set.',
    });
});

app.get('/api/profiles', (_req, res) => {
    fs.mkdirSync(PROFILES, { recursive: true });
    res.json(fs.readdirSync(PROFILES).filter((f) => /\.ya?ml$/.test(f)));
});

// Defaults to localhost, which is right on a laptop: the wizard can write to
// Claude's config and deploy flows, so it should not be reachable from the
// network by accident. In a container 127.0.0.1 means container-local and the
// published port reaches nothing, so compose sets HOST=0.0.0.0 — there the
// network namespace provides the isolation that the bind address provides here.
const HOST = process.env.WIZARD_HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
    console.log(`\n  Modbus copilot setup — http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
    console.log(HOST === '0.0.0.0'
        ? '  Listening on all interfaces (container mode). Anyone who can reach this port can deploy flows.\n'
        : '  Bound to localhost only. Nothing leaves this machine.\n');
});
