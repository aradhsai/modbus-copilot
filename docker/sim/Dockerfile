# The device under test: a Modbus TCP slave that behaves like a pump.
# Built from the repo root so the simulator source stays in sim/ where it belongs.
FROM node:20-alpine
WORKDIR /app
RUN npm install --no-audit --no-fund modbus-serial@8
COPY sim/modbus-slave.js /app/modbus-slave.js
ENV SIM_HOST=0.0.0.0 SIM_PORT=5020
EXPOSE 5020
CMD ["node", "/app/modbus-slave.js"]
