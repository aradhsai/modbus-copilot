/**
 * Two Node-RED nodes:
 *
 *   tag-ingest — takes a block read from ANY protocol node and stores the tags
 *                that fall inside it, decoded and scaled per the device profile.
 *   tag-mcp    — serves those tags to an LLM over MCP, read-only.
 *
 * The split is deliberate. Node-RED already solves acquisition for Modbus, OPC UA,
 * S7, BACnet and everything else; what it has never had is a tag model with units
 * and provenance. Anything that can produce an array of registers can feed this,
 * so adding a protocol is a wiring job, not a code change.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

// Express routes registered on RED.httpNode are never removed when a node is
// closed, so every redeploy would stack another handler on the same path and the
// endpoint would start failing. The route is therefore registered once per
// process and delegates to whichever node instance is currently live.
const routes = new Map();   // path -> { handler: fn|null }

module.exports = function (RED) {

    // ---- tag-ingest ---------------------------------------------------------
    function TagIngest(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.profile = config.profile;
        node.device = config.device;
        node.kind = config.kind;
        node.start = Number(config.start || 0);
        // Set by the generated flow so a failed block only invalidates its own tags.
        node.count = Number(config.count || 0);

        const file = path.resolve(RED.settings.userDir || '.', node.profile);

        const load = (why) => {
            try {
                const dev = store.loadProfile(file);
                node.device = node.device || dev.name;
                node.status({ fill: 'grey', shape: 'ring', text: `${node.device} ${node.kind} ${why}` });
                return true;
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: 'profile error' });
                node.error(`tag-ingest: ${err.message}`);
                return false;
            }
        };
        load('waiting');

        // Reload when the map changes on disk. The wizard rewrites profiles while
        // the runtime is up, and requiring a restart to see a corrected scale is
        // exactly the friction this is meant to remove. Debounced because editors
        // and writers produce several events per save.
        let pending = null;
        try {
            node.watcher = fs.watch(file, () => {
                clearTimeout(pending);
                pending = setTimeout(() => load('profile reloaded'), 250);
            });
        } catch (err) {
            node.warn(`tag-ingest: not watching ${file} (${err.message})`);
        }
        node.on('close', function () {
            clearTimeout(pending);
            if (node.watcher) node.watcher.close();
        });

        node.on('input', function (msg, send, done) {
            try {
                // node-red-contrib-modbus puts the values on msg.payload; a read
                // error arrives as a string or an object with an error field.
                const p = msg.payload;
                const values = Array.isArray(p) ? p
                    : Array.isArray(p && p.data) ? p.data
                        : null;

                if (!values) {
                    // node-red-contrib-modbus's sendEmptyMsgOnFail sets payload to ""
                    // and puts the real exception on msg.error, with the connection
                    // state on msg.error.nodeStatus. Reading only the payload loses
                    // the exception code entirely — and an empty error string is worse
                    // than useless, because it sends whoever reads it (human or model)
                    // hunting for a cause the tool could have named.
                    const e = msg.error;
                    const reason = (e && (e.message || String(e)))
                        || (typeof p === 'string' && p ? p : '')
                        || (p && (p.error || p.message))
                        || 'read failed, no detail reported by the driver';
                    // nodeStatus is often the same string as the message; only add it
                    // when it says something the message does not.
                    const status = e && e.nodeStatus ? String(e.nodeStatus) : '';
                    const state = status && !String(reason).includes(status) && !status.includes(String(reason))
                        ? ` [link ${status}]` : '';
                    const detail = `${reason}${state} (${node.kind} ${node.start}..${node.start + Math.max(node.count, 1) - 1})`;
                    const n = store.markBad(node.device, node.kind, detail, node.start, node.count);
                    node.status({ fill: 'red', shape: 'dot', text: `bad: ${String(reason).slice(0, 24)}` });
                    msg.payload = { quality: 'bad', tags_marked_bad: n, reason: detail };
                    send(msg);
                    return done();
                }

                const stored = store.ingestBlock(node.device, node.kind, node.start, values);
                node.status({
                    fill: stored.length ? 'green' : 'yellow',
                    shape: 'dot',
                    text: `${node.device} ${node.kind}: ${stored.length} tag(s)`,
                });
                msg.payload = stored;
                send(msg);
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: err.message.slice(0, 28) });
                done(err);
            }
        });
    }
    RED.nodes.registerType('tag-ingest', TagIngest);

    // ---- tag-mcp ------------------------------------------------------------
    function TagMcp(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const route = config.route || '/mcp';

        // Read from the environment, never from the flow file. A token committed
        // into flows.json would be shared the moment anyone exports or version-
        // controls their flows, which is exactly what this project encourages.
        const token = (process.env.MODBUS_COPILOT_TOKEN || '').trim();

        // Bound to localhost, no token is a reasonable default — nothing off the
        // machine can reach it. Exposed through a tunnel it is not, so the wizard
        // refuses to start a tunnel without one and this warns loudly either way.
        if (!token) {
            node.warn(
                'tag-mcp: no MODBUS_COPILOT_TOKEN set — this endpoint is unauthenticated. ' +
                'Safe while it is only reachable from this machine; set a token before exposing it.'
            );
        }

        /**
         * Constant-time compare so a wrong token cannot be recovered by timing the
         * rejections. Overkill for a lab, free to do, and the alternative is a
         * subtle weakness in the one control standing between a tunnel and a plant.
         */
        const tokenOk = (header) => {
            if (!token) return true;
            const given = /^Bearer\s+(.+)$/i.exec(String(header || ''))?.[1]?.trim() || '';
            const a = Buffer.from(given);
            const b = Buffer.from(token);
            if (a.length !== b.length) return false;
            return require('crypto').timingSafeEqual(a, b);
        };

        let closed = false;

        (async () => {
            try {
                const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
                const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
                const { z } = await import('zod');

                const server = new McpServer(
                    { name: 'modbus-copilot', version: '0.1.0' },
                    {
                        instructions:
                            'Read-only access to live industrial tag values acquired by Node-RED. ' +
                            'Call list_devices then list_tags before answering questions about what a ' +
                            'device measures — the tag map is authoritative and guessing register ' +
                            'meanings is not acceptable. Every reading carries the address it came from, ' +
                            'the scaling applied and its age in seconds; quote them. If a reading is ' +
                            'stale or its quality is bad, say so rather than reporting the number.',
                    },
                );

                const wrap = (fn) => async (args) => {
                    try {
                        return { content: [{ type: 'text', text: JSON.stringify(fn(args), null, 2) }] };
                    } catch (err) {
                        return { isError: true, content: [{ type: 'text', text: err.message }] };
                    }
                };

                server.tool('list_devices', 'Devices this server has a tag profile for.', {},
                    wrap(() => store.listDevices()));

                server.tool('list_tags', 'Every tag on a device, with units and descriptions.',
                    { device: z.string() },
                    wrap(({ device }) => store.listTags(device)));

                server.tool('search_tags', 'Find tags by name, description or unit.',
                    { device: z.string(), query: z.string() },
                    wrap(({ device, query }) => store.searchTags(device, query)));

                server.tool('read_tag', 'Latest value of one tag, with provenance and age.',
                    { device: z.string(), tag: z.string() },
                    wrap(({ device, tag }) => store.getReading(device, tag)));

                server.tool('read_tags', 'Latest values of several tags.',
                    { device: z.string(), tags: z.array(z.string()) },
                    wrap(({ device, tags }) => tags.map(t => store.getReading(device, t))));

                server.tool('read_all', 'Snapshot of every tag on a device.',
                    { device: z.string() },
                    wrap(({ device }) => store.readAll(device)));

                // Stateless: each POST is handled on its own transport. Simpler than
                // holding sessions inside a flow runtime that can be redeployed
                // underneath us at any moment.
                const handle = async (req, res) => {
                    if (closed) return res.status(503).end();
                    if (!tokenOk(req.headers.authorization)) {
                        // WWW-Authenticate so a client can tell "I need credentials"
                        // from "this endpoint is broken".
                        res.set('WWW-Authenticate', 'Bearer realm="modbus-copilot"');
                        return res.status(401).json({ error: 'missing or invalid bearer token' });
                    }
                    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                    res.on('close', () => { transport.close().catch(() => { }); });
                    try {
                        await server.connect(transport);
                        await transport.handleRequest(req, res, req.body);
                    } catch (err) {
                        node.error(`tag-mcp: ${err.message}`);
                        if (!res.headersSent) res.status(500).json({ error: err.message });
                    }
                };

                if (!routes.has(route)) {
                    const slot = { handler: handle };
                    routes.set(route, slot);

                    RED.httpNode.post(route, (req, res) => {
                        if (!slot.handler) return res.status(503).json({ error: 'no tag-mcp node is active on this route' });
                        slot.handler(req, res);
                    });

                    // A plain GET so a human can confirm the endpoint is alive without
                    // speaking MCP at it — but ONLY for a browser. An MCP client probes
                    // GET with Accept: text/event-stream expecting an SSE channel, and
                    // answering that with a JSON blob and a 200 makes the client think
                    // it has a stream it does not have. This server is stateless, so the
                    // honest answer to that probe is 405.
                    RED.httpNode.get(route, (req, res) => {
                        if ((req.headers.accept || '').includes('text/event-stream')) {
                            return res.status(405).json({
                                error: 'This server is stateless; use POST for MCP requests.',
                            });
                        }
                        // The info page lists devices, so it is behind the same token —
                        // otherwise a tunnel would leak the site's equipment inventory
                        // to anyone with the URL, which is most of what an attacker
                        // would want to know first.
                        if (!tokenOk(req.headers.authorization)) {
                            res.set('WWW-Authenticate', 'Bearer realm="modbus-copilot"');
                            return res.status(401).json({
                                server: 'modbus-copilot', authenticated: false,
                                error: 'bearer token required',
                            });
                        }
                        res.json({
                            server: 'modbus-copilot', transport: 'streamable-http', method: 'POST',
                            authenticated: Boolean(token),
                            devices: store.listDevices(),
                            writable: false,
                            note: 'No write tool exists. Values can be read and reasoned about, not changed.',
                        });
                    });
                } else {
                    // Second node on the same path: take over rather than double-register.
                    // Two devices sharing one endpoint is normal — the store is global,
                    // so either node serves every device.
                    routes.get(route).handler = handle;
                    node.warn(`another tag-mcp node already serves ${route}; this node now handles it`);
                }

                node.status({ fill: 'green', shape: 'dot', text: `MCP on ${route}` });
                node.log(`modbus-copilot MCP endpoint ready at ${route}`);
            } catch (err) {
                node.status({ fill: 'red', shape: 'dot', text: 'mcp failed' });
                node.error(`tag-mcp: ${err.message}`);
            }
        })();

        node.on('close', function () { closed = true; });
    }
    RED.nodes.registerType('tag-mcp', TagMcp);
};
