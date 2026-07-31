/**
 * Modbus TCP slaves that behave like plant, not like sine waves.
 *
 * Two device types, selected with DEVICE=pump|chiller. A demo built on sin(t)
 * proves the plumbing works and nothing else — when every register is a smooth
 * curve you cannot tell a scaling error from a decode error, which is exactly the
 * confusion this project exists to remove.
 *
 * So the values move the way the equipment moves: the pump's discharge follows a
 * curve while suction sags with flow, the chiller's delta-T narrows as load falls,
 * and both hold their heat rather than snapping to target.
 *
 * Unmapped addresses raise an exception, as a real device does. Returning zero
 * would let a wrong address masquerade as a working tag reading zero — the exact
 * confusion the validator exists to remove.
 */
const ModbusRTU = require('modbus-serial');

const DEVICE = (process.env.DEVICE || 'pump').toLowerCase();
const PORT = Number(process.env.SIM_PORT || 5020);
const HOST = process.env.SIM_HOST || '0.0.0.0';

const jitter = (v, pct) => v * (1 + (Math.random() - 0.5) * pct);
const ILLEGAL = () => { throw new Error('Illegal data address'); };

/* ---------------------------------------------------------------- pump ---- */
const pump = {
    state: { speedHz: 42, actualHz: 42, bearingC: 38, runSeconds: 3600 * 214, fault: false },
    step(s) {
        s.actualHz += (s.speedHz - s.actualHz) * 0.15;              // drives lag their setpoint
        const load = s.actualHz / 50;
        const target = 24 + 26 * load + (s.fault ? 12 : 0);
        s.bearingC += (target - s.bearingC) * 0.02;                 // bearings hold their heat
        if (s.actualHz > 1) s.runSeconds += 1;
        if (Math.random() < 0.002) s.fault = !s.fault;              // a fault that never fires teaches nothing
    },
    values(s) {
        const load = s.actualHz / 50;
        return {
            suction: jitter(2.4 - 0.5 * load, 0.01),                // sags as flow rises
            discharge: jitter(1.2 + 5.6 * load * load, 0.01),       // roughly the pump curve
            current: jitter(4 + 34 * load, 0.02) * (s.fault ? 1.18 : 1),
            speed: s.speedHz,
            hours: Math.floor(s.runSeconds / 3600),
            bearing: s.bearingC,
            running: s.actualHz > 1,
            fault: s.fault,
        };
    },
    holding(a, v) {
        switch (a) {
            case 0: return Math.round(v.suction * 10);
            case 1: return Math.round(v.discharge * 10);
            case 2: return Math.round(v.current * 100);
            case 10: return Math.round(v.speed * 10);
            case 20: return (v.hours >>> 16) & 0xffff;              // u32 high word
            case 21: return v.hours & 0xffff;
            default: return ILLEGAL();
        }
    },
    input(a, v) {
        if (a === 5) { const r = Math.round(v.bearing * 10); return r < 0 ? r + 0x10000 : r; }
        return ILLEGAL();
    },
    discrete(a, v) {
        if (a === 0) return v.running;
        if (a === 1) return v.fault;
        return ILLEGAL();
    },
    write(a, val, s) { if (a === 10) s.speedHz = val / 10; },
};

/* ------------------------------------------------------------- chiller ---- */
const chiller = {
    state: { setpointC: 6.5, supplyC: 7.4, returnC: 12.6, loadPct: 62, runSeconds: 3600 * 1180, alarm: false },
    step(s) {
        s.loadPct = Math.min(100, Math.max(15, s.loadPct + (Math.random() - 0.5) * 3));
        s.supplyC += (s.setpointC - s.supplyC) * 0.05;              // chases setpoint, never quite arrives
        // Delta-T narrows as load falls — the low-delta-T behaviour every district
        // cooling engineer recognises, and worth having in the data.
        const deltaT = 2.2 + 4.6 * (s.loadPct / 100);
        s.returnC += (s.supplyC + deltaT - s.returnC) * 0.06;
        s.runSeconds += 1;
        if (Math.random() < 0.0015) s.alarm = !s.alarm;
    },
    values(s) {
        return {
            supply: jitter(s.supplyC, 0.004),
            ret: jitter(s.returnC, 0.004),
            setpoint: s.setpointC,
            load: s.loadPct,
            current: jitter(120 + 260 * (s.loadPct / 100), 0.02),
            hours: Math.floor(s.runSeconds / 3600),
            running: s.loadPct > 18,
            alarm: s.alarm,
        };
    },
    holding(a, v) {
        switch (a) {
            case 0: return Math.round(v.supply * 10);
            case 1: return Math.round(v.ret * 10);
            case 2: return Math.round(v.setpoint * 10);
            case 3: return Math.round(v.load * 10);
            case 4: return Math.round(v.current * 10);
            case 20: return (v.hours >>> 16) & 0xffff;
            case 21: return v.hours & 0xffff;
            default: return ILLEGAL();
        }
    },
    input(a, v) {
        // Delta-T as its own point, because it is the number that gets argued about.
        if (a === 0) return Math.round((v.ret - v.supply) * 10);
        return ILLEGAL();
    },
    discrete(a, v) {
        if (a === 0) return v.running;
        if (a === 1) return v.alarm;
        return ILLEGAL();
    },
    write() { },
};

const DEVICES = { pump, chiller };
const dev = DEVICES[DEVICE];
if (!dev) {
    console.error(`unknown DEVICE=${DEVICE}. Use one of: ${Object.keys(DEVICES).join(', ')}`);
    process.exit(1);
}

setInterval(() => dev.step(dev.state), 1000);

const vector = {
    getHoldingRegister: (a) => dev.holding(a, dev.values(dev.state)),
    getInputRegister: (a) => dev.input(a, dev.values(dev.state)),
    getDiscreteInput: (a) => dev.discrete(a, dev.values(dev.state)),
    getCoil: () => ILLEGAL(),
    setRegister: (a, v) => dev.write(a, v, dev.state),
    setCoil: () => { },
};

const server = new ModbusRTU.ServerTCP(vector, { host: HOST, port: PORT, unitID: 1, debug: false });
server.on('socketError', (err) => console.error('[sim] socket error:', err.message));
server.on('initialized', () => {
    console.log(`[sim] ${DEVICE} on ${HOST}:${PORT}, unit 1 — unmapped addresses raise exceptions, as a real device does`);
});
