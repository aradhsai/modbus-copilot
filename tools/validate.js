#!/usr/bin/env node
/**
 * Commissioning check: is this tag map wired to a device that is actually alive?
 *
 * Deliberately knows nothing about processes. An earlier version carried
 * plausible ranges per unit — is 4 bar sensible for a pump — and it was wrong on
 * both sides: it missed a temperature reading 386 C because the band was wide,
 * and narrowing the band would have failed legitimate plants. There is no setting
 * that works, because the information needed is not in the tag map. Worse, a tool
 * that argues with an engineer about their own process gets uninstalled.
 *
 * So the checks here are structural, and generalise to any device in any industry:
 *
 *   unreachable   the address does not answer
 *   zero          answers, constant zero for the whole window
 *   static        answers, never moved
 *   live          answers and changed
 *
 * plus two internal-consistency notes that need no process knowledge: an unsigned
 * tag reading above 32767, and 32-bit values shown in BOTH word orders so the
 * engineer picks rather than the tool guessing.
 *
 * Findings roll up. If every tag under a branch is unreachable, the branch is the
 * problem — one line, not forty. The detail is always still there underneath.
 *
 * Nothing here writes to the device.
 */
const path = require('path');
const ModbusRTU = require('modbus-serial');
const store = require(path.join(__dirname, '..', 'nodered', 'nodes', 'tag-copilot', 'store.js'));

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

async function readTag(client, tag, unitId) {
    client.setID(unitId);
    if (tag.kind === 'holding') return (await client.readHoldingRegisters(tag.address, tag.registers)).data;
    if (tag.kind === 'input') return (await client.readInputRegisters(tag.address, tag.registers)).data;
    if (tag.kind === 'coil') return (await client.readCoils(tag.address, 1)).data[0];
    return (await client.readDiscreteInputs(tag.address, 1)).data[0];
}

function classify(tag, samples, device) {
    const errs = samples.filter((s) => s.error);
    if (errs.length === samples.length) {
        return { status: 'unreachable', detail: errs[0].error, notes: [] };
    }

    const ok = samples.filter((s) => !s.error);
    const values = ok.map((s) => s.value);
    const notes = [];

    if (errs.length) {
        notes.push({
            code: 'intermittent',
            text: `${errs.length}/${samples.length} reads failed — check cabling, unit id, or a gateway dropping requests under load`,
        });
    }

    // Unsigned tag carrying what is almost certainly a negative number.
    if (tag.type === 'uint16') {
        const highs = ok.map((s) => Array.isArray(s.raw) ? s.raw[0] : 0).filter((r) => r > 32767);
        if (highs.length) {
            notes.push({
                code: 'sign',
                text: `raw up to ${Math.max(...highs)} on a uint16 — a negative int16 looks exactly like this`,
            });
        }
    }

    // 32-bit: show both readings rather than judging which is plausible. Judging
    // requires knowing the process, which is precisely what this tool refuses to do.
    if (tag.registers === 2) {
        const last = ok[ok.length - 1];
        const swapped = store.decode(tag, [last.raw[1], last.raw[0]], device.byteOrder, device.wordOrder);
        if (swapped !== last.value) {
            notes.push({
                code: 'word_order',
                text: `reads ${last.value} as mapped, ${swapped} with words swapped — confirm which is right`,
            });
        }
    }

    const changed = values.some((v) => v !== values[0]);
    if (changed) return { status: 'live', notes };
    // "zero" is a numeric diagnosis — a register answering with nothing behind it.
    // A boolean sitting at false is just static, and calling it zero reads as a
    // fault when it is usually a pump that is off.
    if (tag.type !== 'bool' && values.every((v) => v === 0)) return { status: 'zero', notes };
    return { status: 'static', detail: values[0], notes };
}

function groupOf(tag) { return tag.path || '(ungrouped)'; }

function main() {
    const args = process.argv.slice(2);
    const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };

    const profilePath = opt('profile', 'profiles/site-a.yaml');
    const minutes = Number(opt('minutes', 0));
    const samples = minutes ? Math.max(4, Math.round((minutes * 60) / 2)) : Number(opt('samples', 6));
    const interval = minutes ? 2000 : Number(opt('interval', 900));
    const hostOverride = opt('host', null);
    const portOverride = Number(opt('port', 0));
    const showAll = args.includes('--all');

    const dev = store.loadProfile(path.resolve(profilePath));
    const entry = store.getDevice(dev.name);
    const raw = require('js-yaml').load(require('fs').readFileSync(path.resolve(profilePath), 'utf8'));
    const host = hostOverride || raw.device.host;
    const port = portOverride || Number(raw.device.port || 502);
    const unitId = Number(raw.device.unit_id || 1);
    const windowSec = ((samples - 1) * interval) / 1000;

    const client = new ModbusRTU();
    client.setTimeout(Number(raw.device.timeout_seconds || 3) * 1000);

    console.log(`\n${dev.name} — ${entry.tags.size} tags · ${host}:${port} unit ${unitId} · soaking ${windowSec.toFixed(0)}s\n`);

    client.connectTCP(host, { port })
        .then(async () => {
            const collected = new Map();
            for (let s = 0; s < samples; s++) {
                for (const tag of entry.tags.values()) {
                    let rec;
                    try {
                        const v = await readTag(client, tag, unitId);
                        rec = { raw: v, value: store.decode(tag, v, entry.device.byteOrder, entry.device.wordOrder) };
                    } catch (err) {
                        rec = { error: err.message };
                    }
                    if (!collected.has(tag.name)) collected.set(tag.name, []);
                    collected.get(tag.name).push(rec);
                }
                if (s < samples - 1) await new Promise((r) => setTimeout(r, interval));
            }
            client.close(() => { });
            report(entry, collected, showAll, windowSec);
        })
        .catch((err) => {
            // Device-level failure. One line, because forty tag errors would all be
            // saying the same thing.
            console.log(`✗  NOT COMMUNICATING — ${err.message}`);
            console.log(`   0 of ${entry.tags.size} tags could be read.`);
            console.log('   Check the device is powered and on this network, the port is open,');
            console.log('   and that no other master is holding the link.\n');
            process.exit(2);
        });
}

function report(entry, collected, showAll, windowSec) {
    const groups = new Map();
    for (const tag of entry.tags.values()) {
        const g = groupOf(tag);
        if (!groups.has(g)) groups.set(g, []);
        const c = classify(tag, collected.get(tag.name), entry.device);
        groups.get(g).push({ tag, ...c });
    }

    const totals = { live: 0, static: 0, zero: 0, unreachable: 0 };
    for (const rows of groups.values()) for (const r of rows) totals[r.status]++;
    const all = entry.tags.size;

    const mark = totals.unreachable === all ? '✗' : totals.unreachable ? '▲' : '●';
    console.log(`${mark}  ${totals.live} live · ${totals.static} static · ${totals.zero} zero · ${totals.unreachable} unreachable\n`);

    for (const [name, rows] of [...groups].sort()) {
        const n = { live: 0, static: 0, zero: 0, unreachable: 0 };
        for (const r of rows) n[r.status]++;

        // Roll-up: when a whole branch shares one fate, that is the finding.
        if (n.unreachable === rows.length) {
            console.log(`✗  ${pad(name, 28)} NOT RESPONDING — ${rows.length} tags, none answered`);
            console.log(`   ${' '.repeat(28)}${rows[0].detail}`);
            console.log(`   ${' '.repeat(28)}One cause, not ${rows.length}: wrong address block, unwired card, or device offline.`);
        } else if (n.unreachable) {
            // Partly unreachable is its own story, and it must outrank "no movement" —
            // an address that does not exist is a different job from a tag that is idle.
            console.log(`▲  ${pad(name, 28)} ${n.unreachable} of ${rows.length} UNREACHABLE${n.live ? ` · ${n.live} live` : ''}`);
            console.log(`   ${' '.repeat(28)}Part of this block answers, so the device is fine — these addresses are wrong.`);
        } else if (n.zero === rows.length) {
            console.log(`▲  ${pad(name, 28)} ALL ZERO — ${rows.length} tags answer, every value constant zero`);
            console.log(`   ${' '.repeat(28)}Addresses exist but nothing is behind them. Usually unwired or not yet commissioned.`);
        } else if (n.live === 0) {
            console.log(`▲  ${pad(name, 28)} NO MOVEMENT — ${rows.length} tags, none changed in ${windowSec.toFixed(0)}s`);
        } else {
            console.log(`●  ${pad(name, 28)} ${n.live} live${n.static ? ` · ${n.static} static` : ''}${n.zero ? ` · ${n.zero} zero` : ''}${n.unreachable ? ` · ${n.unreachable} unreachable` : ''}`);
        }

        // Detail is never hidden, only collapsed: anything that does not share the
        // group's fate is promoted back out, and --all shows everything.
        const groupFate = n.unreachable === rows.length ? 'unreachable'
            : n.zero === rows.length ? 'zero'
                : n.live === 0 ? 'static' : null;

        for (const r of rows) {
            const odd = groupFate === null ? r.status !== 'live' : r.status !== groupFate && r.status !== 'zero' && r.status !== 'static';
            if (!showAll && !odd && !r.notes.length) continue;
            if (!showAll && groupFate && !r.notes.length && r.status === groupFate) continue;

            const last = collected.get(r.tag.name).filter((s) => !s.error).pop();
            const v = last ? (typeof last.value === 'number' ? last.value.toFixed(2) : String(last.value)) : '—';
            console.log(`      ${pad(r.tag.name, 24)} ${lpad(v, 10)} ${pad(r.tag.unit || '', 5)} ${r.status}`);
            for (const note of r.notes) console.log(`         ↳ ${note.code}: ${note.text}`);
        }
        console.log('');
    }

    if (totals.static + totals.zero > 0 && windowSec < 60) {
        console.log(`Soaked only ${windowSec.toFixed(0)}s. Setpoints and slow analogs legitimately do not move in that time —`);
        console.log('run --minutes 5 before concluding a point is dead.\n');
    }

    const fatal = totals.unreachable;
    console.log(fatal
        ? `${fatal} tag(s) unreachable. Fix those before anything downstream is built on this map.\n`
        : 'Every tag answered. Nothing downstream will inherit a broken address from this map.\n');
    process.exit(fatal ? 1 : 0);
}

try { main(); } catch (err) { console.error(`\n${err.message}\n`); process.exit(2); }
