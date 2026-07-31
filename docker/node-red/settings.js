/**
 * Node-RED settings for the container.
 *
 * Differs from the local one in two ways: userDir is /data (the image's
 * convention), and the tag-copilot nodes arrive as an installed npm package
 * rather than through nodesDir.
 */
module.exports = {
    uiPort: 1880,
    flowFile: 'flows.json',
    userDir: '/data',
    functionGlobalContext: {},
    logging: { console: { level: 'info', metrics: false, audit: false } },
    editorTheme: { projects: { enabled: false } },

    // The MCP transport POSTs JSON to an httpNode route, and Node-RED does not
    // body-parse those by default — without this the server receives an empty
    // body and every request fails in a way that looks like a protocol bug.
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
