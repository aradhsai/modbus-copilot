/**
 * Device profile -> Node-RED flow.
 *
 * The integrator should never open Node-RED to get a device polling. They give
 * the wizard an address and a tag list; this turns that into the reader nodes,
 * and the admin API deploys them. Node-RED stays as the protocol engine — its
 * real value — without being homework.
 *
 * Blocking matters: reading 300 scattered registers one at a time is slow enough
 * to be noticed on a serial link, and Modbus caps a single read at 125 registers
 * anyway. So addresses are clustered into runs, tolerating small gaps because
 * reading a few unused registers is far cheaper than another round trip.
 */
const MAX_BLOCK = 100;   // registers per read, under the 125 protocol ceiling

// Gap bridging is off by default, and that default was learned the hard way.
// Reading across unmapped registers is only free if the device tolerates it —
// plenty answer "illegal data address" for the gap and reject the entire block,
// so one unused register between two tags silently kills every tag in the read.
// Contiguous runs only. Raise this per-device once you know the device is
// forgiving; fewer round trips is a real gain on serial links.
const MAX_GAP = Number(process.env.MODBUS_COPILOT_MAX_GAP || 0);

const KIND_TO_FC = {
    holding: 'HoldingRegister',
    input: 'InputRegister',
    coil: 'Coil',
    discrete: 'Input',
};

function blocksFor(tags) {
    const spans = tags
        .map((t) => ({
            start: t.address,
            end: t.address + (t.type === 'bool' ? 1 : ({ uint32: 2, int32: 2, float32: 2 }[t.type] || 1)),
        }))
        .sort((a, b) => a.start - b.start);

    const blocks = [];
    for (const s of spans) {
        const last = blocks[blocks.length - 1];
        if (last && s.start - last.end <= MAX_GAP && s.end - last.start <= MAX_BLOCK) {
            last.end = Math.max(last.end, s.end);
        } else {
            blocks.push({ start: s.start, end: s.end });
        }
    }
    return blocks.map((b) => ({ start: b.start, quantity: b.end - b.start }));
}

/**
 * @returns {Array} Node-RED node objects for one device, including its tab.
 */
function generate(profile, profileRelPath, { pollSeconds = 2, mcpRoute = '/mcp', includeMcp = true } = {}) {
    const dev = profile.device;
    const slug = dev.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const tabId = `tab_${slug}`;
    const clientId = `cfg_${slug}`;

    const nodes = [
        {
            id: tabId, type: 'tab', label: dev.name, disabled: false,
            info: `Generated from ${profileRelPath}. Edits here are overwritten next time the wizard deploys this device.`,
        },
        {
            id: clientId, type: 'modbus-client', name: `${dev.name} link`,
            clienttype: dev.transport === 'rtu' ? 'serial' : 'tcp',
            bufferCommands: true, stateLogEnabled: false, queueLogEnabled: false, failureLogEnabled: true,
            tcpHost: dev.host || '127.0.0.1', tcpPort: String(dev.port || 502), tcpType: 'DEFAULT',
            serialPort: dev.serial_port || '/dev/ttyUSB', serialType: 'RTU-BUFFERD',
            serialBaudrate: dev.baudrate || 9600, serialDatabits: 8, serialStopbits: 1, serialParity: 'none',
            serialConnectionDelay: 100, serialAsciiResponseStartDelimiter: '0x3A',
            unit_id: Number(dev.unit_id || 1), commandDelay: 1,
            clientTimeout: Math.round((dev.timeout_seconds || 3) * 1000),
            reconnectOnTimeout: true, reconnectTimeout: 2000, parallelUnitIdsAllowed: true,
            showErrors: false, showWarnings: true, showLogs: true,
        },
    ];

    const byKind = new Map();
    for (const t of profile.tags) {
        if (!byKind.has(t.kind)) byKind.set(t.kind, []);
        byKind.get(t.kind).push(t);
    }

    let y = 80;
    for (const [kind, tags] of byKind) {
        for (const [i, block] of blocksFor(tags).entries()) {
            const readId = `rd_${slug}_${kind}_${i}`;
            const ingestId = `ing_${slug}_${kind}_${i}`;
            nodes.push({
                id: readId, type: 'modbus-read', z: tabId,
                name: `${kind} ${block.start}..${block.start + block.quantity - 1}`,
                topic: '', showStatusActivities: true, logIOActivities: false,
                showErrors: true, showWarnings: true,
                unitid: String(dev.unit_id || 1), dataType: KIND_TO_FC[kind],
                adr: String(block.start), quantity: String(block.quantity),
                rate: String(pollSeconds), rateUnit: 's',
                delayOnStart: false, enableDeformedMessages: false, startDelayTime: '',
                server: clientId, useIOFile: false, ioFile: '', useIOForPayload: false,
                // Without this a failed read produces nothing, and the tags keep their
                // last value forever — the exact "trusting a dead point" failure.
                emptyMsgOnFail: true,
                x: 180, y, wires: [[ingestId], []],
            });
            nodes.push({
                id: ingestId, type: 'tag-ingest', z: tabId,
                name: `${kind} tags`, profile: profileRelPath, device: dev.name,
                kind, start: block.start, count: block.quantity,
                x: 440, y, wires: [[]],
            });
            y += 70;
        }
    }

    if (includeMcp) {
        nodes.push({
            id: `mcp_${slug}`, type: 'tag-mcp', z: tabId,
            name: `MCP ${mcpRoute}`, route: mcpRoute,
            x: 180, y: y + 40, wires: [],
        });
    }

    return { nodes, tabId, blocks: nodes.filter((n) => n.type === 'modbus-read').length };
}

module.exports = { generate, blocksFor };
