#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"
[ "$#" -eq 1 ] || { echo "Usage: restore.sh BACKUP_DIRECTORY" >&2; exit 1; }
backup_dir=$(CDPATH= cd -- "$1" && pwd)
require_quiesced
(cd "$backup_dir" && sha256sum -c SHA256SUMS)
# Refuse anything but a new, empty target: no drop, clean or overwrite flags.
objects=$(compose --profile tools run --rm -T --no-deps tools psql -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f');")
[ "$objects" = 0 ] || { echo "Restore target database is not empty" >&2; exit 1; }
compose --profile tools run --rm -T --no-deps tools sh -c '[ -z "$(ls -A /data/attachments)" ]' || { echo "Restore target attachments are not empty" >&2; exit 1; }
# Restrict archive members to relative paths and reject links and special files.
tar -tf "$backup_dir/attachments.tar" | awk 'substr($0,1,1)=="/" || $0 ~ /(^|\/)\.\.(\/|$)/ {exit 1}' || { echo "Unsafe attachment archive path" >&2; exit 1; }
tar -tvf "$backup_dir/attachments.tar" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}' || { echo "Unsupported attachment archive member" >&2; exit 1; }
compose --profile tools run --rm -T --no-deps tools sh -c 'exec pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -d "$PGDATABASE"' < "$backup_dir/database.dump"
compose --profile tools run --rm -T --no-deps tools tar -C /data/attachments --no-same-owner -xf - < "$backup_dir/attachments.tar"
echo "Restore completed; validate before starting application services."
