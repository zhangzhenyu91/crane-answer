#!/bin/sh
set -eu

mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"
exec gosu node "$@"
