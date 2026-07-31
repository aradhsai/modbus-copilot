# Node-RED with the Modbus nodes and the tag-copilot nodes preinstalled.
# The tag layer ships as a normal npm package, so it behaves here exactly as it
# would if someone installed it from the palette.
FROM nodered/node-red:4.0

USER root
COPY --chown=node-red:node-red nodered/nodes/tag-copilot /data/tag-copilot-node
COPY --chown=node-red:node-red profiles /data/profiles
COPY --chown=node-red:node-red docker/node-red/flows.json /data/flows.json
COPY --chown=node-red:node-red docker/node-red/settings.js /data/settings.js
USER node-red

# Install into /data without changing WORKDIR: the base image's ENTRYPOINT is
# ./entrypoint.sh relative to /usr/src/node-red, so moving WORKDIR breaks startup.
# The base image already picks up /data/settings.js on its own, so no CMD override.
RUN cd /data && npm install --no-audit --no-fund --unsafe-perm \
      node-red-contrib-modbus@5 @modelcontextprotocol/sdk zod@3 js-yaml@4 ./tag-copilot-node

EXPOSE 1880
