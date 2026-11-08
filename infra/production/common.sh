#!/bin/sh
set -eu
: "${COMPOSE_PROJECT_NAME:?Set an explicit unique COMPOSE_PROJECT_NAME}"
: "${RELAY_ENV_FILE:?Set RELAY_ENV_FILE to the absolute environment file path}"
case "$RELAY_ENV_FILE" in /*) ;; *) echo "RELAY_ENV_FILE must be absolute" >&2; exit 1;; esac
[ -f "$RELAY_ENV_FILE" ] || { echo "Environment file missing" >&2; exit 1; }
script_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
compose() { docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" -f "$script_root/compose.production.yaml" "$@"; }
require_quiesced() {
  running=$(compose ps --status running --services)
  for service in web worker caddy; do
    if printf '%s\n' "$running" | grep -Fxq "$service"; then
      echo "Stop web, worker and caddy before backup or restore" >&2; exit 1
    fi
  done
  if ! printf '%s\n' "$running" | grep -Fxq postgres; then
    echo "Start the project's healthy postgres service first" >&2; exit 1
  fi
}
