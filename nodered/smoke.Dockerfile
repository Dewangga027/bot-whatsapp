# syntax=docker/dockerfile:1
FROM nodered/node-red:5.0.9-24@sha256:2ccd38b4066648bd5e17430c50a2f8102c566a82fd4f2fc5c342e61664d6896f

USER root
WORKDIR /opt/monitoring-dashboard
COPY nodered/package.json nodered/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/monitoring-npm-cache \
    && rm -rf /tmp/monitoring-npm-cache \
    && rm -f /data/flows.json

COPY nodered/smoke-flow.json /opt/monitoring-seed/flows.json
COPY nodered/smoke-settings.cjs /opt/monitoring-seed/settings.js
COPY nodered/settings.fragment.cjs /opt/monitoring-seed/settings.fragment.cjs
COPY nodered/package.json nodered/package-lock.json /opt/monitoring-seed/
COPY --chmod=755 <<'START' /usr/local/bin/monitoring-smoke
#!/bin/sh
set -eu
umask 077
data_entry=$(find /data -mindepth 1 -maxdepth 1 -print -quit)
if [ -z "$data_entry" ]; then
  cp /opt/monitoring-seed/flows.json /opt/monitoring-seed/settings.js /opt/monitoring-seed/settings.fragment.cjs /opt/monitoring-seed/package.json /opt/monitoring-seed/package-lock.json /data/
  ln -s /opt/monitoring-dashboard/node_modules /data/node_modules
fi
if [ ! -f /data/settings.js ] || [ ! -f /data/flows.json ]; then
  printf '%s\n' 'Volume /data tidak kosong tetapi settings.js/flows.json belum tersedia; tidak menimpa data.' >&2
  exit 1
fi
exec node /usr/src/node-red/node_modules/node-red/red.js --userDir /data --settings /data/settings.js
START

USER node-red
WORKDIR /usr/src/node-red
EXPOSE 1880
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/monitoring-smoke"]
