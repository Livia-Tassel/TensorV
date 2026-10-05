#!/bin/sh
set -eu
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  "${TENSORV_PYTHON:-python3}" -m venv .venv
fi
if ! .venv/bin/python -c 'import torch, numpy' >/dev/null 2>&1; then
  .venv/bin/python -m pip install -r requirements.txt
fi
if [ ! -d node_modules ]; then
  npm ci
fi
npm run build
exec .venv/bin/python -m tensorv.server "$@"
