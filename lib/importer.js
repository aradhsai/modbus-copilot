/**
 * Tag database -> device profile. Pure: text in, object out, no console, no files.
 *
 * Shared by the CLI and the wizard so there is exactly one implementation of the
 * address conversion. Two copies of that logic would eventually disagree, and the
 * disagreement would be silent.
 */
const COLUMNS = {
    name: ['tag', 'tagname', 'tag_name', 'name', 'point', 'pointname', 'symbol'],
    address: ['address', 'register', 'addr', 'modbusaddress', 'reg', 'offset'],
    type: ['type', 'datatype', 'data_type', 'format'],
    scale: ['scale', 'scaling', 'multiplier', 'factor', 'gain'],
    offsetValue: ['offsetvalue', 'bias', 'zero'],
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

function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
            else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => clean(f) !== ''));
}

function mapHeaders(header) {
    const found = {}, unmatched = [];
    header.forEach((h, i) => {
        const k = key(h);
        let hit = null;
        for (const [field, aliases] of Object.entries(COLUMNS)) if (aliases.includes(k)) { hit = field; break; }
        if (hit && !(hit in found)) found[hit] = i;
        else if (!hit) unmatched.push(h);
    });
    return { found, unmatched };
}

/** 40001 -> holding 0 · 30006 -> input 5 · 10001 -> discrete 0 · 00001 -> coil 0 */
function resolveAddress(rawAddress, declaredKind, declaredType) {
    const s = clean(rawAddress).replace(/\s/g, '');
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`address "${clean(rawAddress)}" is not a number`);

    const explicit = {
        holding: 'holding', holdingregister: 'holding', '3': 'holding', fc3: 'holding',
        input: 'input', inputregister: 'input', '4': 'input', fc4: 'input',
        coil: 'coil', '1': 'coil', fc1: 'coil',
        discrete: 'discrete', discreteinput: 'discrete', '2': 'discrete', fc2: 'discrete',
    }[key(declaredKind)];
    if (explicit) return { kind: explicit, address: n };

    if (s.length >= 5) {
        const lead = s[0], rest = Number(s.slice(1));
        if (lead === '4') return { kind: 'holding', address: rest - 1 };
        if (lead === '3') return { kind: 'input', address: rest - 1 };
        if (lead === '1') return { kind: 'discrete', address: rest - 1 };
        if (lead === '0') return { kind: 'coil', address: rest - 1 };
    }
    return { kind: declaredType === 'bool' ? 'discrete' : 'holding', address: n };
}

function buildPath(row, cols) {
    if (cols.path !== undefined) {
        const p = clean(row[cols.path]);
        if (p) return p.replace(/[\\.]/g, '/').replace(/^\/+|\/+$/g, '');
    }
    const parts = [];
    for (const f of ['area', 'equipment']) {
        if (cols[f] !== undefined) { const v = clean(row[cols[f]]); if (v) parts.push(v); }
    }
    return parts.join('/');
}

function importCsv(text, device = {}) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('file has no data rows');

    const { found, unmatched } = mapHeaders(rows[0]);
    if (found.name === undefined) throw new Error('no tag-name column. Expected one of: ' + COLUMNS.name.join(', '));
    if (found.address === undefined) throw new Error('no address column. Expected one of: ' + COLUMNS.address.join(', '));

    const tags = [], problems = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = clean(r[found.name]);
        if (!name) continue;
        try {
            const declaredType = TYPES[key(r[found.type])] || null;
            const { kind, address } = resolveAddress(r[found.address], found.kind !== undefined ? r[found.kind] : '', declaredType);
            const isBit = kind === 'coil' || kind === 'discrete';
            const tag = {
                name,
                description: found.description !== undefined ? clean(r[found.description]) : '',
                path: buildPath(r, found),
                kind, address,
                type: isBit ? 'bool' : (declaredType || 'uint16'),
                access: 'r',
            };
            if (!isBit) {
                const raw = found.scale !== undefined ? clean(r[found.scale]) : '';
                tag.scale = raw === '' ? 1 : Number(raw);
                if (!Number.isFinite(tag.scale)) { tag.scale = 1; problems.push(`${name}: scale "${raw}" unreadable, defaulted to 1`); }
                if (found.offsetValue !== undefined && clean(r[found.offsetValue])) tag.offset = Number(clean(r[found.offsetValue]));
            }
            const unit = found.unit !== undefined ? clean(r[found.unit]) : '';
            if (unit) tag.unit = unit;
            tags.push(tag);
        } catch (err) {
            problems.push(`row ${i + 1} (${name}): ${err.message} — skipped`);
        }
    }

    const groups = {};
    for (const t of tags) groups[t.path || '(ungrouped)'] = (groups[t.path || '(ungrouped)'] || 0) + 1;

    return {
        profile: {
            profile_version: 1,
            device: {
                name: device.name || 'Device',
                description: device.description || '',
                transport: 'tcp',
                host: device.host || '127.0.0.1',
                port: Number(device.port || 502),
                unit_id: Number(device.unitId || 1),
                // A guess, and labelled as one. The checker reports both readings
                // for any 32-bit tag so this gets confirmed rather than assumed.
                byte_order: 'big',
                word_order: 'big',
                timeout_seconds: 3,
            },
            tags,
        },
        understood: Object.keys(found),
        ignored: unmatched,
        groups,
        problems,
        count: tags.length,
    };
}

module.exports = { importCsv, parseCsv, resolveAddress, COLUMNS, TYPES };
