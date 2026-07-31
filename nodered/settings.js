const path = require('path');

module.exports = {
    uiPort: process.env.NR_PORT || 1880,
    flowFile: 'flows.json',
    userDir: path.resolve(__dirname, '..'),          // profiles/ resolve from repo root
    nodesDir: path.resolve(__dirname, 'nodes'),
    functionGlobalContext: {},
    logging: { console: { level: 'info', metrics: false, audit: false } },
    editorTheme: { projects: { enabled: false } },
    // The MCP transport posts JSON; Node-RED's http node needs to parse it.
    httpNodeMiddleware: function (req, res, next) {
        if (req.method === 'POST' && (req.headers['content-type'] || '').includes('application/json')) {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
                next();
            });
        } else {
            next();
        }
    },
};
