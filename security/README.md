# security/ — man on the wire (Part 1: Modbus TCP)

The lab **method** behind the article *"A stranger moved my pump"* — the first of the
["man on the wire" series](https://aradhs.com/lab). It proves one claim on real,
captured traffic: **Modbus TCP offers no authentication and no integrity, so anyone
who can reach the segment can read every value and write any register — including a
running pump's speed setpoint.**

This is evidence for a *defensive* article. It is not a tool to point at a plant.
**Run only against equipment you own, on an isolated lab network.**

## What's here

| File | Role |
|---|---|
| `capture.sh` | Sniff a live Modbus conversation on the homelab docker bridge, drive one setpoint write, restore it. Produces `modbus.pcap`. |
| `drive.js` | The dangerous half: connect to the pump, write holding register 10 (speed, Hz×10), read back, restore. No credential is offered because Modbus asks for none. |
| `mitm-tap.js` | The explicit man-in-the-middle relay, for reproducing the position without a bridge/SPAN port. Logs every frame in the clear. |
| `captures/modbus.pcap` | A real capture: 100 frames, 46 reads + the FC06 write. |

## Where it runs

The modbus-copilot lab runs on the homelab docker host — **CT100 `/opt/stack/tag-copilot`**
(`tagcopilot-pump`, `-chiller`, `-nodered`, `-wizard`). Labs run in the homelab, never
on a laptop. Capture there; pull only the `.pcap` back to author the piece.

## The finding, hand-decoded

The two write requests, in cleartext on the wire (12 bytes of Modbus each):

```
00 02 0000 0006 01 06 000a 0096     write reg 10 = 0x0096 = 150 = 15.0 Hz   (hostile)
00 04 0000 0006 01 06 000a 01a4     write reg 10 = 0x01a4 = 420 = 42.0 Hz   (restore)
                  │  │    └── value
                  │  └─────── register 10  (pump speed setpoint)
                  └────────── function 06  (write single register)
```

`drive.js` output from the captured run:

```
BEFORE   reg10 = 420  (42.0 Hz)
WROTE    reg10 = 150  (15.0 Hz)   <- nobody at the HMI did this
AFTER    reg10 = 150  (15.0 Hz)
RESTORED reg10 = 420  (42.0 Hz)   (lab left as found)
```

## Decode a capture

```bash
tshark -r captures/modbus.pcap -d tcp.port==5020,mbtcp -Y modbus \
       -T fields -e frame.number -e modbus.func_code       # function-code histogram
tshark -r captures/modbus.pcap -d tcp.port==5020,mbtcp -Y 'modbus.func_code==6' \
       -T fields -e frame.number -e ip.src -e ip.dst -e tcp.payload   # the writes
```

(`-d tcp.port==5020,mbtcp` because the lab runs Modbus off the default port 502.)

## The defense (the article's real payload)

Modbus can't be fixed at the protocol layer — the fix is the network drawing:
segmentation into zones and conduits, read-only / one-way paths for anything that
doesn't need to write, and monitoring that would flag an FC06 to a setpoint register
from a host that has no business issuing one. See
[Modbus isn't insecure. Your network is](https://aradhs.com/blog/modbus-isnt-insecure).
