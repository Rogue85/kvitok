#!/bin/sh
# Modes of the production image:
#   api          migrations (unless MIGRATE_ON_START=false), then the HTTP API with the web interface on $PORT
#   worker       the queue worker: replies, webhooks, mail, the agent
#   migrate      migrations only
#   cli <args>   the admin CLI, e.g. `cli user:create --email … --password … --name … --superadmin`
#   healthcheck  exits 0 when /api/health answers ok
# Anything else runs as a command.
set -e
cd /app

case "$1" in
  api)
    if [ "${MIGRATE_ON_START:-true}" = "true" ]; then
      node_modules/.bin/prisma migrate deploy
    fi
    exec node dist/main.js
    ;;
  worker)
    exec node dist/worker.js
    ;;
  migrate)
    exec node_modules/.bin/prisma migrate deploy
    ;;
  cli)
    shift
    exec node dist/cli.js "$@"
    ;;
  healthcheck)
    exec node -e "fetch('http://127.0.0.1:${PORT:-3001}/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
    ;;
  *)
    exec "$@"
    ;;
esac
