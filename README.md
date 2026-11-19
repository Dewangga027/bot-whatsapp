# bot-whatsapp

## Local queue inspection

Bull Board is available at http://localhost:3000/ops/queues when the API is running.
Use `OPS_USER` (default `operator`) and the contents of `ops-password` from the
effective `SECRETS_DIR`. The filename itself is not the password. For a WSL
deployment, read the file inside the configured WSL distribution. Check the port's
owning container if login fails; WAHA can also occupy port 3000.

The API uses the `api_host` bridge to publish its localhost port. Redis and
PostgreSQL remain on private networks.

To inspect an already-running development gateway using `wa-gateway-test-redis`
on the existing `wa-gateway-test` network, run from the project directory in WSL:

```sh
docker compose -f compose.yaml -f compose.gateway-development.yaml config --quiet
docker compose -f compose.yaml -f compose.gateway-development.yaml up -d --no-deps api
```

This override uses the development Redis test credential for the API only. It
does not move jobs, change the gateway's WhatsApp session, or start/reconfigure a
worker. Keep using both Compose files when recreating this development API;
using the base file alone switches it back to the monitoring Redis.

Select `monitoring-drawdown` and the Waiting tab. Jobs stay Waiting until a worker
connected to that same Redis and queue processes them. The base worker uses the
monitoring Redis and will not consume the development gateway queue.
