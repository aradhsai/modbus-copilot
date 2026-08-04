"""Minimal S7comm slave (Siemens) for the man-on-the-wire lab.
Serves one data block, DB1, over ISO-TSAP / S7comm on tcp/102 — exactly what a
Siemens PLC exposes. No authentication, because S7comm's optional password is a
protection level, not a session credential. Own equipment / isolated lab only.
Version-robust across python-snap7 API changes."""
import time, ctypes, sys
import snap7

# resolve the SERVER DB area constant across python-snap7 versions.
# Note: the server uses SrvArea (small enum), not the client's Area (S7 code 0x84).
AREA_DB = None
for path in [
    lambda: __import__("snap7.type", fromlist=["SrvArea"]).SrvArea.DB,
    lambda: __import__("snap7.server", fromlist=["SrvArea"]).SrvArea.DB,
    lambda: __import__("snap7.types", fromlist=["srvAreaDB"]).srvAreaDB,
]:
    try:
        AREA_DB = path(); break
    except Exception:
        pass
if AREA_DB is None:
    print("could not resolve DB area constant", flush=True); sys.exit(1)
print(f"using DB area constant = {AREA_DB!r}", flush=True)

Server = snap7.server.Server
srv = Server()
DB1 = (ctypes.c_uint8 * 64)()
# seed DB1.DBW0 = 4200 (42.0 Hz x100) so a reader sees plant-like data
DB1[0], DB1[1] = (4200 >> 8) & 0xFF, 4200 & 0xFF
srv.register_area(AREA_DB, 1, DB1)
srv.start()  # binds 0.0.0.0:102
print("S7 server up on :102, DB1 seeded DBW0=4200", flush=True)
while True:
    time.sleep(2)
