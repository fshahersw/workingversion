#!/bin/sh
set -eu

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
export NITRO_PORT="${NITRO_PORT:-$PORT}"

node -e 'const m=require("./build-metadata.json");if(m.environment!==process.env.APP_ENVIRONMENT){throw new Error(`artifact environment ${m.environment} does not match runtime ${process.env.APP_ENVIRONMENT}`)}'
exec node server/index.mjs
