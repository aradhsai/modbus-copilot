/**
 * mitm-tap.js — a man in the middle of a Modbus TCP conversation.
 *
 * Part 1 of the "man on the wire" series. This is the attacker position, made
 * explicit: a TCP relay that the poller talks to instead of the device, and that
 * forwards every byte to the real device unchanged. Nothing is modified — the
 * point is only to prove what the position can SEE.
 *
 * On a real flat network the same position is taken by ARP spoofing, not by
 * asking the poller to connect to you. We do not reproduce that here: the payload
 * exposure is identical, and the defensive lesson (segment the network so this
 * position cannot be taken) does not depend on the mechanism.
 *
 * RUN THIS ONLY against equipment you own, on an isolated lab network.
 *
 *   listen : 127.0.0.1:${TAP_PORT   || 5555}
 *   forward: ${DEVICE_HOST || 127.0.0.1}:${DEVICE_PORT || 5020}
 *   log    : ${OUT || security/wire.jsonl}   (one JSON line per frame)
 */
const net = require('net');
const fs = require('fs');

const TAP_PORT = Number(process.env.TAP_PORT || 5555);
const DEVICE_HOST = process.env.DEVICE_HOST || '127.0.0.1';
const DEVICE_PORT = Number(process.env.DEVICE_PORT || 5020);
const OUT = process.env.OUT || `${__dirname}/wire.jsonl`;

const log = fs.createWriteStream(OUT, { flags: 'w' });
const record = (dir, buf) =>
  log.write(JSON.stringify({ t: Date.now() / 1000, dir, hex: buf.toString('hex') }) + '\n');

const server = net.createServer((poller) => {
  const device = net.createConnection(DEVICE_PORT, DEVICE_HOST);
  poller.on('data', (b) => { record('c2s', b); device.write(b); });   // request, in the clear
  device.on('data', (b) => { record('s2c', b); poller.write(b); });   // response, in the clear
  const end = () => { poller.end(); device.end(); };
  poller.on('close', end); device.on('close', end);
  poller.on('error', end); device.on('error', end);
});

server.listen(TAP_PORT, '127.0.0.1', () =>
  console.log(`[tap] on the wire: 127.0.0.1:${TAP_PORT} -> ${DEVICE_HOST}:${DEVICE_PORT}, logging ${OUT}`));
