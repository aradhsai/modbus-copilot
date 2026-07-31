/**
 * Soak a device against a tag map and report structurally. Pure data out.
 *
 * Knows nothing about processes on purpose. An earlier version carried plausible
 * ranges per unit and was wrong in both directions — it passed a temperature
 * reading 386 C because the band was wide, and narrowing the band would have
 * failed legitimate plants. The information needed is not in the tag map, and a
 * tool that argues with an engineer about their own process gets uninstalled.
 *
 * What is left generalises to any device in any industry:
 *   unreachable · zero · static · live
 * plus notes that need no process knowledge — an unsigned tag reading above
 * 32767, and 32-bit values shown in BOTH word orders so a human picks.
 */
const path = require('path');
const ModbusRTU = require('modbus-serial');
const store = require(path.join(__dirname, '..', 'nodered', 'nodes', 'tag-copilot', 'store.js'));

async function readTag(client, tag, unitId) {
    client.setID(unitId);
    if (tag.kind === 'holding') return (await client.readHoldingRegisters(tag.address, tag.registers)).data;
    if (tag.kind === 'input') return (await client.readInputRegisters(tag.address, tag.registers)).data;
    if (tag.kind === 'coil') return (await client.readCoils(tag.address, 1)).data[0];
    return (await client.readDiscreteInputs(tag.address, 1)).data[0];
}

function classify(tag, samples, device) {
    const errs = samples.filter((s) => s.error);
    // value is always present, null when there is nothing to report — so a caller
    // never has to special-case one status to read the same field.
    if (errs.length === samples.length) return { status: 'unreachable', value: null, detail: errs[0].error, notes: [] };

    const ok = samples.filter((s) => !s.error);
    const values = ok.map((s) => s.value);
    const notes = [];

    if (errs.length) notes.push({ code: 'intermittent', text: `${errs.length}/${samples.length} reads failed — check cabling, unit id, or a gateway dropping requests under load` });

    if (tag.type === 'uint16') {
        const highs = ok.map((s) => (Array.isArray(s.raw) ? s.raw[0] : 0)).filter((r) => r > 32767);
        if (highs.length) notes.push({ code: 'sign', text: `raw up to ${Math.max(...highs)} on a uint16 — a negative int16 looks exactly like this` });
    }

    if (tag.registers === 2 && ok.length) {
        const last = ok[ok.length - 1];
        const swapped = store.decode(tag, [last.raw[1], last.raw[0]], device.byteOrder, device.wordOrder);
        if (swapped !== last.value) {
            notes.push({ code: 'word_order', text: `reads ${last.value} as mapped, ${swapped} with words swapped — confirm which is right` });
        }
    }

    const last = ok[ok.length - 1];
    const value = last ? last.value : null;
    if (values.some((v) => v !== values[0])) return { status: 'live', value, notes };
    // "zero" is a numeric diagnosis. A boolean at false is static — usually a
    // stopped pump, not a fault.
    if (tag.type !== 'bool' && values.every((v) => v === 0)) return { status: 'zero', value, notes };
    return { status: 'static', value, notes };
}

/**
 * @returns {Promise<{connected:boolean, error?:string, totals:object, groups:Array, windowSec:number}>}
 */
async function check(profileYamlPath, { samples = 6, interval = 900, host, port } = {}, onProgress) {
    const dev = store.loadProfile(profileYamlPath);
    const entry = store.getDevice(dev.name);
    const raw = require('js-yaml').load(require('fs').readFileSync(profileYamlPath, 'utf8'));

    const target = { host: host || raw.device.host, port: Number(port || raw.device.port || 502) };
    const unitId = Number(raw.device.unit_id || 1);
    const windowSec = ((samples - 1) * interval) / 1000;

    const client = new ModbusRTU();
    client.setTimeout(Number(raw.device.timeout_seconds || 3) * 1000);

    try {
        await client.connectTCP(target.host, { port: target.port });
    } catch (err) {
        return {
            connected: false,
            error: err.message,
            device: dev.name, target, tagCount: entry.tags.size,
            totals: { live: 0, static: 0, zero: 0, unreachable: entry.tags.size },
            groups: [], windowSec,
        };
    }

    const collected = new Map();
    for (let s = 0; s < samples; s++) {
        for (const tag of entry.tags.values()) {
            let rec;
            try {
                const v = await readTag(client, tag, unitId);
                rec = { raw: v, value: store.decode(tag, v, entry.device.byteOrder, entry.device.wordOrder) };
            } catch (err) { rec = { error: err.message }; }
            if (!collected.has(tag.name)) collected.set(tag.name, []);
            collected.get(tag.name).push(rec);
        }
        if (onProgress) onProgress(s + 1, samples);
        if (s < samples - 1) await new Promise((r) => setTimeout(r, interval));
    }
    client.close(() => { });

    const byGroup = new Map();
    const totals = { live: 0, static: 0, zero: 0, unreachable: 0 };
    for (const tag of entry.tags.values()) {
        const g = tag.path || '(ungrouped)';
        if (!byGroup.has(g)) byGroup.set(g, []);
        const c = classify(tag, collected.get(tag.name), entry.device);
        totals[c.status]++;
        byGroup.get(g).push({
            tag: tag.name, unit: tag.unit || '', kind: tag.kind, address: tag.address,
            ...c,
        });
    }

    // Roll-up: when a whole branch shares one fate, that is the finding — one line,
    // not forty. Detail is collapsed, never discarded.
    const groups = [...byGroup].sort().map(([name, rows]) => {
        const n = { live: 0, static: 0, zero: 0, unreachable: 0 };
        for (const r of rows) n[r.status]++;
        let verdict, headline;
        if (n.unreachable === rows.length) {
            verdict = 'not_responding';
            headline = `NOT RESPONDING — ${rows.length} tags, none answered. One cause, not ${rows.length}: wrong address block, unwired card, or device offline.`;
        } else if (n.unreachable) {
            verdict = 'partly_unreachable';
            headline = `${n.unreachable} of ${rows.length} UNREACHABLE — part of this block answers, so the device is fine; these addresses are wrong.`;
        } else if (n.zero === rows.length) {
            verdict = 'all_zero';
            headline = `ALL ZERO — addresses exist but nothing is behind them. Usually unwired or not yet commissioned.`;
        } else if (n.live === 0) {
            verdict = 'no_movement';
            headline = `NO MOVEMENT — nothing changed in ${windowSec.toFixed(0)}s.`;
        } else {
            verdict = 'ok';
            headline = `${n.live} live${n.static ? ` · ${n.static} static` : ''}${n.zero ? ` · ${n.zero} zero` : ''}`;
        }
        return { name, verdict, headline, counts: n, rows };
    });

    return { connected: true, device: dev.name, target, tagCount: entry.tags.size, totals, groups, windowSec };
}

async function testConnection(host, port, unitId = 1, timeoutMs = 3000) {
    const client = new ModbusRTU();
    client.setTimeout(timeoutMs);
    try {
        await client.connectTCP(host, { port: Number(port) });
        client.setID(Number(unitId));
        // A single read proves the unit id answers, not just that a socket opened.
        let probe = 'socket open';
        try {
            await client.readHoldingRegisters(0, 1);
            probe = 'holding register 0 answered';
        } catch (err) {
            probe = `socket open, but unit ${unitId} did not answer a read: ${err.message}`;
        }
        client.close(() => { });
        return { ok: true, detail: probe };
    } catch (err) {
        return { ok: false, detail: err.message };
    }
}

module.exports = { check, testConnection, classify };
