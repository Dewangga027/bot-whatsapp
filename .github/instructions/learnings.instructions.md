---
description: Diagnose local monitoring ops access and Redis queue visibility
applyTo: '**'
---

# Local ops diagnosis

- Before diagnosing a login failure on port 3000, identify the owning container with `docker ps --filter publish=3000`. WAHA can use the same port; an HTTP Basic challenge alone does not identify Bull Board. Verify `/ops/queues` returns 200 with the application's operator credential and 401 without it.
- Resolve secret files from the effective Compose environment and `SECRETS_DIR`, including shell overrides. A Windows checkout can use secrets inside WSL; check readability there and keep secret values out of diagnostics. Secret filenames are not passwords.
- When the bot responds but Bull Board is empty, compare gateway and API Redis host, network, secret source, queue name, and job counts. A ping reply creates no job; checklist confirmation proves staging, not PostgreSQL persistence. Use the development override documented in the README only when inspecting the existing development gateway; it changes the API connection, not the worker connection. Preserve source jobs and WhatsApp auth volumes.
- In the observed Docker Engine 29.9.2 setup, an API attached only to internal networks had configured PortBindings but no published socket. An additional non-internal bridge restored host access. Verify actual `docker port` output and a host HTTP request; keep Redis and PostgreSQL on their private networks.
