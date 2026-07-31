# modbus-copilot

Ask a Modbus device questions by tag name instead of by register number.

```
you:     what's the suction pressure on Pump-01?
claude:  2.0 bar — holding register 0, raw 20, scaled x0.1, read 1s ago
```

Not this, which is what a raw Modbus MCP server gives you:

```
you:     read holding registers 40001 to 40010
```

That difference is the whole project. A Modbus device answers questions about
register 40001. An engineer asks about suction pressure. The meaning in between
lives in a vendor PDF and in the head of whoever commissioned the panel.

Write-up: **[I gave Claude a live Modbus device](https://aradhs.com/lab/modbus-copilot)**

---

## Run the whole lab

Two simulated devices, Node-RED polling them, an MCP server, and a setup UI:

```bash
git clone https://github.com/aradhsai/modbus-copilot
cd modbus-copilot
docker compose up -d
```

| | |
|---|---|
| MCP endpoint | `http://localhost:1882/mcp` |
| Setup UI | `http://localhost:3002` |
| Node-RED editor | `http://localhost:1882` |
| Pump / chiller (Modbus TCP) | `localhost:5022` / `localhost:5023` |

Ports are off the defaults because 1880 and 3000 are usually taken on a machine
that runs other things. Override with `NODERED_PORT`, `WIZARD_PORT`, `PUMP_PORT`,
`CHILLER_PORT`.

## Connect Claude Desktop

```json
{
  "mcpServers": {
    "modbus-copilot": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:1882/mcp", "--allow-http"]
    }
  }
}
```

Claude Desktop launches *stdio* servers, so a bare `{ "url": ... }` will not work —
`mcp-remote` bridges stdio to the HTTP endpoint. With a token set, add
`"--header", "Authorization: Bearer <token>"`.

Then ask it: *what devices can you see?* · *give me a snapshot of both* ·
*where exactly did that number come from?*

## It does not write

There is **no write tool**. Not disabled by a flag, not gated behind a role —
absent from the codebase, so no misconfiguration can enable one.

An LLM holding a writable handle to running plant is a bad idea, and the only way
to be certain a misconfiguration cannot enable one is for the code not to exist.
If you need supervisory writes, build that path deliberately, with an interlock and
an operator in front of it. Do not inherit it from a chat client.

## The profile is the asset

One YAML file per device model. Version it, review it, share it — so one person's
afternoon with the vendor manual becomes a reusable artefact instead of tribal
knowledge.

```yaml
device:
  name: Pump-01
  host: 192.0.2.10
  unit_id: 1
  byte_order: big
  word_order: big      # stated, never defaulted

tags:
  - name: suction_pressure
    kind: holding
    address: 0          # the manual says 40001
    type: uint16
    scale: 0.1
    unit: bar
```

Two things it is strict about, because both are where Modbus work quietly goes
wrong:

**Addresses are zero-based protocol addresses.** A manual saying 40001 means
holding register 0. The conversion happens once, at import, so nothing downstream
has to work out which convention a number is written in.

**Word order must be declared.** A 32-bit value assembled the wrong way round
produces a number that looks plausible and is wrong, which is worse than an error.
A profile that does not say is rejected at load.

## Check the map before you trust it

```bash
node tools/validate.js --profile profiles/pump-01.yaml --host localhost --port 5022
```

Reads every tag several times and reports what answers, what never moves, and what
does not exist. Findings roll up: if every tag under a branch is unreachable then
the branch is the finding, one line rather than forty.

```
▲  3 live · 3 static · 0 zero · 3 unreachable

✗  Plant-Room/Dosing-01   NOT RESPONDING — 3 tags, none answered.
                          One cause, not 3: wrong address block, unwired card, or device offline.
●  Plant-Room/Pump-01     3 live · 3 static
      running_hours              214.00 h    holding@20
         ↳ word_order: reads 214 as mapped, 14024704 with words swapped — confirm which is right
```

It deliberately knows nothing about processes. An earlier version carried plausible
ranges per unit so it could catch a missing scale factor; it passed a temperature
reading 386 °C because the band was wide, and narrowing the band would have failed
legitimate plants. There is no setting that works, because the information needed is
not in the tag map — and a tool that argues with an engineer about their own process
gets uninstalled. What is left is structural and generalises to any device.

## Import a tag database

```bash
node tools/import-csv.js --in samples/site-taglist.csv --device Site-A --host 192.0.2.10
```

Column names are matched loosely, `4xxxx/3xxxx/1xxxx/0xxxx` are converted, and
Area/Equipment columns become the hierarchy the report rolls up by.

## Tools the model gets

| Tool | Answers |
|---|---|
| `list_devices` | what is configured |
| `list_tags` | every point, with units |
| `search_tags` | "which tags mention temperature?" |
| `read_tag` | one point, with provenance |
| `read_tags` | several, sharing a moment |
| `read_all` | a snapshot |

The tag map is exposed *as tools* rather than pasted into a prompt, because small
models act on tools and ignore paragraphs.

## Architecture

```
device ──▶ Node-RED ──▶ tag layer ──▶ MCP ──▶ assistant
           any protocol   name · unit ·        read-only
                          scale · age
```

Node-RED does acquisition, and that is the point rather than a compromise:
`node-red-contrib-modbus` alone gets ~12,400 downloads a week, and the same
ecosystem covers OPC UA, S7 and BACnet. What it has never had is a tag model. Add
one, and adding a protocol becomes a wiring job rather than a code change.

## Not production

The simulator behaves like plant — the pump's discharge follows a curve, its
bearing holds heat, the chiller's delta-T narrows as load falls — but it is still a
simulator behaving well. A real panel has a serial gateway that drops requests
under load, a manual that disagrees with the device, and a unit ID nobody wrote
down. Take this as a commissioning aid and a starting point, not a product.

## Credit

The idea of putting Modbus behind MCP is not mine — [alejoseb/ModbusMCP](https://github.com/alejoseb/ModbusMCP)
got there first and proved the shape. This takes a different line: it adds the
semantic layer, and it drops write support on purpose.

Apache-2.0.
