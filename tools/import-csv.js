#!/usr/bin/env node
/**
 * Turn a tag database into a device profile.
 *
 * Integrators do not arrive with YAML. They arrive with a CSV exported from a
 * vendor tool, a commissioning spreadsheet, or a point list someone typed. The
 * columns are never named the same way twice, so this matches headers loosely
 * and reports what it understood rather than demanding a fixed template.
 *
 * The one conversion that matters: 4xxxx / 3xxxx / 1xxxx / 0xxxx data-model
 * numbers become a register kind plus a zero-based protocol address. A manual
 * saying 40001 means holding register 0. Doing that once, here, is why nothing
 * downstream has to guess which convention a number is written in.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Header aliases. Order matters only in that the first hit wins.
const COLUMNS = {
    name: ['tag', 'tagname', 'tag_name', 'name', 'point', 'pointname', 'symbol'],
    address: ['address', 'register', 'addr', 'modbusaddress', 'reg', 'offset'],
    type: ['type', 'datatype', 'data_type', 'format'],
    scale: ['scale', 'scaling', 'multiplier', 'factor', 'gain'],
    offset: ['offset_value', 'bias', 'zero'],
    unit: ['unit', 'units', 'eu', 'engineeringunits', 'uom'],
    description: ['description', 'desc', 'comment', 'notes', 'text'],
    kind: ['kind', 'functioncode', 'fc', 'registertype', 'table'],
    path: ['path', 'group', 'folder', 'hierarchy'],
    area: ['area', 'station', 'plant', 'zone', 'section'],
    equipment: ['equipment', 'device', 'asset', 'machine', 'unit_name'],
};

const TYPES = {
    uint16: 'uint16', word: 'uint16', ushort: 'uint16', u16: 'uint16', unsigned: 'uint16',
    int16: 'int16', short: 'int16', i16: 'int16', signed: 'int16',
    uint32: 'uint32', dword: 'uint32', udint: 'uint32', u32: 'uint32',
    int32: 'int32', dint: 'int32', long: 'int32', i32: 'int32',
    float32: 'float32', float: 'float32', real: 'float32', f32: 'float32',
    bool: 'bool', boolean: 'bool', bit: 'bool', digital: 'bool', discrete: 'bool',
};

const clean = (s) => String(s ?? '').trim();
const key = (s) => clean(s).toLowerCase().replace(/[\s_\-.]/g, '');

/** Minimal CSV reader: quoted fields, embedded commas, CRLF. No dependency needed. */
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => clean(f) !== ''));
}

function mapHeaders(header) {
    const found = {};
    const unmatched = [];
    header.forEach((h, i) => {
        const k = key(h);
        let hit = null;
        for (const [field, aliases] of Object.entries(COLUMNS)) {
            if (aliases.includes(k)) { hit = field; break; }
        }
        if (hit && !(hit in found)) found[hit] = i;
        else if (!hit) unmatched.push(h);
    });
    return { found, unmatched };
}

/**
 * 40001 -> holding 0, 30006 -> input 5, 10001 -> discrete 0, 00001 -> coil 0.
 * A bare number with no data-model prefix is taken as already zero-based.
 */
function resolveAddress(rawAddress, declaredKind, declaredType) {
    const s = clean(rawAddress).replace(/\s/g, '');
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`address "${clean(rawAddress)}" is not a number`);

    const kindHint = key(declaredKind);
    const explicit = {
        holding: 'holding', holdingregister: 'holding', '3': 'holding', fc3: 'holding',
        input: 'input', inputregister: 'input', '4': 'input', fc4: 'input',
        coil: 'coil', '1': 'coil', fc1: 'coil',
        discrete: 'discrete', discreteinput: 'discrete', '2': 'discrete', fc2: 'discrete',
    }[kindHint];

    if (explicit) return { kind: explicit, address: n };

    // Data-model prefixes are only meaningful at 5 or 6 digits.
    if (s.length >= 5) {
        const lead = s[0];
        const rest = Number(s.slice(1));
        if (lead === '4') return { kind: 'holding', address: rest - 1 };
        if (lead === '3') return { kind: 'input', address: rest - 1 };
        if (lead === '1') return { kind: 'discrete', address: rest - 1 };
        if (lead === '0') return { kind: 'coil', address: rest - 1 };
    }

    // No prefix, no declared kind: infer from the type and take it as zero-based.
    return { kind: declaredType === 'bool' ? 'discrete' : 'holding', address: n };
}

function buildPath(row, cols) {
    if (cols.path !== undefined) {
        const p = clean(row[cols.path]);
        if (p) return p.replace(/[\\.]/g, '/').replace(/^\/+|\/+$/g, '');
    }
    const parts = [];
    for (const f of ['area', 'equipment']) {
        if (cols[f] !== undefined) {
            const v = clean(row[cols[f]]);
            if (v) parts.push(v);
        }
    }
    return parts.join('/');
}

function main() {
    const args = process.argv.slice(2);
    const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };

    const input = opt('in', args[0]);
    if (!input) {
        console.error('usage: import-csv.js --in <taglist.csv> --device <name> --host <ip> [--port 502] [--unit 1] [--out profiles/x.yaml]');
        process.exit(2);
    }
    const deviceName = opt('device', path.basename(input).replace(/\.[^.]+$/, ''));
    const host = opt('host', '127.0.0.1');
    const port = Number(opt('port', 502));
    const unitId = Number(opt('unit', 1));
    const out = opt('out', `profiles/${deviceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.yaml`);

    const rows = parseCsv(fs.readFileSync(input, 'utf8'));
    if (rows.length < 2) throw new Error('file has no data rows');

    const { found, unmatched } = mapHeaders(rows[0]);
    if (found.name === undefined) throw new Error('no tag-name column found. Expected one of: ' + COLUMNS.name.join(', '));
    if (found.address === undefined) throw new Error('no address column found. Expected one of: ' + COLUMNS.address.join(', '));

    console.log(`\nReading ${input}`);
    console.log('columns understood: ' + Object.keys(found).join(', '));
    if (unmatched.length) console.log('columns ignored   : ' + unmatched.join(', '));

    const tags = [];
    const problems = [];

    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = clean(r[found.name]);
        if (!name) continue;
        try {
            const declaredType = TYPES[key(r[found.type])] || null;
            const { kind, address } = resolveAddress(
                r[found.address],
                found.kind !== undefined ? r[found.kind] : '',
                declaredType,
            );
            const isBit = kind === 'coil' || kind === 'discrete';
            const type = declaredType || (isBit ? 'bool' : 'uint16');
            if (isBit && type !== 'bool') problems.push(`${name}: ${kind} forced to bool (was ${type})`);

            const scaleRaw = found.scale !== undefined ? clean(r[found.scale]) : '';
            const tag = {
                name,
                description: found.description !== undefined ? clean(r[found.description]) : '',
                path: buildPath(r, found),
                kind,
                address,
                type: isBit ? 'bool' : type,
                access: 'r',
            };
            if (!isBit) {
                tag.scale = scaleRaw === '' ? 1 : Number(scaleRaw);
                if (!Number.isFinite(tag.scale)) { tag.scale = 1; problems.push(`${name}: scale "${scaleRaw}" unreadable, defaulted to 1`); }
                if (found.offset !== undefined && clean(r[found.offset])) tag.offset = Number(clean(r[found.offset]));
            }
            const unit = found.unit !== undefined ? clean(r[found.unit]) : '';
            if (unit) tag.unit = unit;
            tags.push(tag);
        } catch (err) {
            problems.push(`row ${i + 1} (${name}): ${err.message} — skipped`);
        }
    }

    const profile = {
        profile_version: 1,
        device: {
            name: deviceName,
            description: `Imported from ${path.basename(input)}`,
            transport: 'tcp',
            host, port, unit_id: unitId,
            // Stated, not defaulted: a wrong word order produces numbers that look
            // plausible and are wrong. The validator will tell you if this is wrong.
            byte_order: 'big',
            word_order: 'big',
            timeout_seconds: 3,
        },
        tags,
    };

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, yaml.dump(profile, { lineWidth: 100, noRefs: true }));

    const groups = new Map();
    for (const t of tags) groups.set(t.path || '(ungrouped)', (groups.get(t.path || '(ungrouped)') || 0) + 1);

    console.log(`\n${tags.length} tags imported into ${out}`);
    for (const [g, n] of [...groups].sort()) console.log(`  ${g.padEnd(30)} ${n}`);

    if (problems.length) {
        console.log(`\n${problems.length} thing(s) to check:`);
        for (const p of problems) console.log(`  - ${p}`);
    }

    console.log('\nword_order is a guess. Validate before trusting any 32-bit value:');
    console.log(`  node tools/validate.js --profile ${out} --minutes 2\n`);
}

try { main(); } catch (err) { console.error(`\n${err.message}\n`); process.exit(1); }
