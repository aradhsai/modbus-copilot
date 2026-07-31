/**
 * The shared tag store.
 *
 * One process-wide map of device -> tag -> last reading. Every protocol node in
 * Node-RED can feed it; the MCP server only reads from it. That separation is
 * the whole architecture: acquisition is Node-RED's problem and it is already
 * solved for Modbus, OPC UA, S7, BACnet and the rest — meaning is ours.
 *
 * Readings carry their provenance and their age. A value with no timestamp is
 * indistinguishable from a value that stopped updating an hour ago, and in a
 * plant those are very different facts.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const devices = new Map();   // name -> { device, tags: Map<name, tagdef> }
const readings = new Map();  // "device\u0000tag" -> reading

const WIDTH = {
    uint16: 1, int16: 1,
    uint32: 2, int32: 2, float32: 2,
    bool: 0,
};

// NUL separator: it cannot occur in a device or tag name, so composite keys
// can never collide the way a space or a dot would. Written as an escape so
// the file stays text — a raw NUL byte makes git treat the source as binary.
const key = (device, tag) => `${device}\u0000${tag}`;

function loadProfile(file) {
    const raw = yaml.load(fs.readFileSync(file, 'utf8'));
    if (!raw || !raw.device) throw new Error(`${path.basename(file)}: no device section`);

    const d = raw.device;
    for (const k of ['byte_order', 'word_order']) {
        if (d[k] !== 'big' && d[k] !== 'little') {
            // Refusing beats defaulting. A wrong word order yields numbers that
            // look plausible and are wrong, which is worse than an error.
            throw new Error(`${path.basename(file)}: device.${k} must be 'big' or 'little' — state it, do not leave it to be guessed`);
        }
    }

    const tags = new Map();
    for (const t of raw.tags || []) {
        if (!t.name) throw new Error(`${path.basename(file)}: a tag has no name`);
        const type = t.type || ((t.kind === 'coil' || t.kind === 'discrete') ? 'bool' : null);
        if (!(type in WIDTH)) throw new Error(`${path.basename(file)}: tag ${t.name} has unknown type ${type}`);
        tags.set(t.name, {
            name: t.name,
            // Hierarchy from the tag database (Area/Equipment, or a path column).
            // Roll-up reporting depends on it: forty dead tags under one branch is
            // one problem, not forty.
            path: t.path || '',
            kind: t.kind,
            address: Number(t.address),
            type,
            registers: WIDTH[type],
            scale: t.scale === undefined ? 1 : Number(t.scale),
            offset: t.offset === undefined ? 0 : Number(t.offset),
            unit: t.unit || '',
            description: t.description || '',
            access: t.access || 'r',
        });
    }
    if (!tags.size) throw new Error(`${path.basename(file)}: profile defines no tags`);

    const device = {
        name: d.name,
        model: d.model || '',
        description: d.description || '',
        byteOrder: d.byte_order,
        wordOrder: d.word_order,
        profile: file,
    };
    devices.set(device.name, { device, tags });
    return device;
}

function decode(tag, words, byteOrder, wordOrder) {
    if (tag.type === 'bool') return Boolean(words);

    const w = wordOrder === 'big' ? words.slice() : words.slice().reverse();
    const buf = Buffer.alloc(w.length * 2);
    w.forEach((v, i) => buf.writeUInt16BE(v & 0xffff, i * 2));
    if (byteOrder === 'little') {
        for (let i = 0; i < buf.length; i += 2) buf.writeUInt16LE(buf.readUInt16BE(i), i);
    }

    let v;
    switch (tag.type) {
        case 'uint16': v = buf.readUInt16BE(0); break;
        case 'int16': v = buf.readInt16BE(0); break;
        case 'uint32': v = buf.readUInt32BE(0); break;
        case 'int32': v = buf.readInt32BE(0); break;
        case 'float32': v = buf.readFloatBE(0); break;
        default: throw new Error(`unhandled type ${tag.type}`);
    }
    const scaled = v * tag.scale + tag.offset;
    // 564 * 0.1 is 56.400000000000006 in binary floating point. Reporting that to
    // an engineer reads as a broken instrument, so trim the representation error
    // without inventing precision the raw value never had.
    return Math.round(scaled * 1e6) / 1e6;
}

/**
 * Take a block read for one register kind and store every tag that falls inside it.
 * Returns the tags it resolved, so a flow can show what it understood.
 */
function ingestBlock(deviceName, kind, startAddress, values) {
    const entry = devices.get(deviceName);
    if (!entry) throw new Error(`unknown device ${deviceName} — is its profile loaded?`);

    const at = new Date().toISOString();
    const stored = [];

    for (const tag of entry.tags.values()) {
        if (tag.kind !== kind) continue;
        const offset = tag.address - startAddress;
        const span = tag.type === 'bool' ? 1 : tag.registers;
        if (offset < 0 || offset + span > values.length) continue;   // outside this block

        const slice = tag.type === 'bool' ? values[offset] : values.slice(offset, offset + span);
        let reading;
        try {
            reading = {
                device: deviceName, tag: tag.name,
                value: decode(tag, slice, entry.device.byteOrder, entry.device.wordOrder),
                unit: tag.unit, quality: 'good', raw: slice,
                address: tag.address, kind: tag.kind, type: tag.type,
                scaling: tag.type === 'bool' ? 'none' : `raw * ${tag.scale} + ${tag.offset}`,
                read_at: at,
            };
        } catch (err) {
            reading = {
                device: deviceName, tag: tag.name, quality: 'bad',
                error: err.message, address: tag.address, kind: tag.kind, read_at: at,
            };
        }
        readings.set(key(deviceName, tag.name), reading);
        stored.push(reading);
    }
    return stored;
}

/**
 * Mark the tags covered by ONE failed block read as bad.
 *
 * Scoped by address range, not just by kind. A device with several blocks of the
 * same kind will have some fail and some succeed, and marking every holding tag
 * bad because one block returned an exception reports healthy points as broken —
 * which is worse than useless during commissioning, because it sends an engineer
 * chasing a fault that is not there.
 */
function markBad(deviceName, kind, reason, start, count) {
    const entry = devices.get(deviceName);
    if (!entry) return 0;
    const at = new Date().toISOString();
    const scoped = Number.isFinite(start) && Number.isFinite(count) && count > 0;
    let n = 0;
    for (const tag of entry.tags.values()) {
        if (kind && tag.kind !== kind) continue;
        if (scoped) {
            const span = tag.type === 'bool' ? 1 : tag.registers;
            if (tag.address < start || tag.address + span > start + count) continue;
        }
        readings.set(key(deviceName, tag.name), {
            device: deviceName, tag: tag.name, quality: 'bad',
            error: reason, address: tag.address, kind: tag.kind, read_at: at,
        });
        n++;
    }
    return n;
}

function getReading(deviceName, tagName) {
    const entry = devices.get(deviceName);
    if (!entry) throw new Error(`unknown device ${deviceName}`);
    if (!entry.tags.has(tagName)) {
        const near = [...entry.tags.keys()].filter(t => t.toLowerCase().includes(tagName.toLowerCase()));
        throw new Error(
            `no tag ${tagName} on ${deviceName}` +
            (near.length ? `. Did you mean: ${near.slice(0, 5).join(', ')}?` : '')
        );
    }
    const r = readings.get(key(deviceName, tagName));
    if (!r) {
        const t = entry.tags.get(tagName);
        return {
            device: deviceName, tag: tagName, quality: 'stale',
            error: 'never read since this server started — is the polling flow deployed and connected?',
            address: t.address, kind: t.kind, unit: t.unit,
        };
    }
    return withAge(r);
}

function withAge(r) {
    const ageSeconds = Math.round((Date.now() - Date.parse(r.read_at)) / 1000);
    // Surfacing age matters: a value that stopped updating an hour ago looks
    // identical to a live one until you ask when it was read.
    return { ...r, age_seconds: ageSeconds, stale: ageSeconds > 30 };
}

const listDevices = () => [...devices.values()].map(({ device, tags }) => ({
    device: device.name, model: device.model, description: device.description,
    tags: tags.size, profile: device.profile,
    byte_order: device.byteOrder, word_order: device.wordOrder,
    writable_from_here: false,
}));

function listTags(deviceName) {
    const entry = devices.get(deviceName);
    if (!entry) throw new Error(`unknown device ${deviceName}`);
    return [...entry.tags.values()].map(t => ({
        tag: t.name, description: t.description, unit: t.unit,
        kind: t.kind, address: t.address, type: t.type, access: t.access,
    }));
}

function searchTags(deviceName, query) {
    const q = String(query || '').toLowerCase().trim();
    return listTags(deviceName).filter(t =>
        t.tag.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.unit || '').toLowerCase().includes(q));
}

const readAll = (deviceName) =>
    listTags(deviceName).map(t => getReading(deviceName, t.tag));

const getDevice = (name) => devices.get(name);

module.exports = {
    loadProfile, ingestBlock, markBad, getReading,
    listDevices, listTags, searchTags, readAll,
    // exported so the validator can reuse the exact decode path the runtime uses —
    // a checker that decodes differently from the server is checking the wrong thing
    decode, getDevice, WIDTH,
    _devices: devices,
};
