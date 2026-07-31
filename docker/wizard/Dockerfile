# The setup UI. Talks to Node-RED's admin API to deploy generated flows, and
# writes profiles into a directory shared with Node-RED.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund express@4 js-yaml@4 modbus-serial@8
COPY lib ./lib
COPY wizard ./wizard
COPY nodered/nodes/tag-copilot ./nodered/nodes/tag-copilot
EXPOSE 3000
CMD ["node", "wizard/server.js"]
