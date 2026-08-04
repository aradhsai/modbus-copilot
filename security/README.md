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

---

# The rest of the series

The full "man on the wire" series, each part a real capture on the same isolated lab.
Same rule everywhere: own equipment only.

| Part | Article | Protocol | Money shot (real capture) |
|---|---|---|---|
| 1 | [A stranger moved my pump](https://aradhs.com/lab/stranger-pump) | Modbus TCP | FC06 write reg 10 = `0x0096` (15.0 Hz), no auth |
| 2 | [Two vendors, one open wire](https://aradhs.com/lab/two-vendors) | EtherNet/IP + S7comm | CIP write `SETPOINT=0x1770`; S7 Write Var `DB1.DBW0=0x05dc` |
| 3 | [The broker trusted everyone](https://aradhs.com/lab/broker-trust) | MQTT / Sparkplug | `allow_anonymous`; unauth host published `valve/command=0` |
| 4 | [The door that could say no](https://aradhs.com/lab/opcua-capstone) | OPC UA | 42.0 on the wire once — NoSecurity yes, Sign&Encrypt no |

## Part 2 — EtherNet/IP + S7comm (sims)

```bash
# EtherNet/IP (cpppo) — a CIP tag server, and a client that writes a tag:
python -m cpppo.server.enip --address 0.0.0.0:44818 MOTOR_CMD=INT SETPOINT=INT LEVEL=INT
python -m cpppo.server.enip.client --address <plc>:44818 SETPOINT=6000 SETPOINT

# S7comm (python-snap7) — s7-server.py serves DB1; s7-write.py writes DB1.DBW0:
python s7-server.py            # binds tcp/102, DB1 seeded
python s7-write.py             # writes 1500 (15.0 Hz), reads back, restores
```

Decode: `tshark -r enip.pcap -Y cip` · `tshark -r s7.pcap -Y s7comm` (both auto-dissect).

## Part 3 — MQTT / Sparkplug

Sniff `tcp/1883` on the broker bridge; every CONNECT shows no username/password. One
anonymous publish moves a control topic:

```bash
mosquitto_pub -h <broker> -t northwind/rotterdam/T101/valve/command -m 0   # no -u/-P
```

Decode: `tshark -r mqtt.pcap -Y 'mqtt.msgtype==1' -e mqtt.conflag.uname -e mqtt.conflag.passwd`.

## Part 4 — OPC UA (capstone)

`opcua-server.py` offers **both** NoSecurity and Sign&Encrypt on tcp/4840;
`opcua-read.py` reads `Pump.Speed` through each door. The value 42.0 crosses the wire
in the clear exactly once — the NoSecurity read.

```bash
python opcua-server.py         # NoSecurity + Basic256Sha256 Sign&Encrypt
python opcua-read.py           # reads through both doors
# proof: the IEEE-754 double for 42.0 appears once in the whole capture
tshark -r opcua.pcap -T fields -e tcp.payload | tr -d '\n' | grep -oc 0000000000004540
```

> Kepware (the aggregator Part 4 frames) is Windows-only, so an open OPC UA server
> stood in for it. The role — plaintext south, Sign&Encrypt north — is the point.
