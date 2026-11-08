#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"
[ "$#" -eq 1 ] || { echo "Usage: backup.sh NEW_BACKUP_DIRECTORY" >&2; exit 1; }
require_quiesced
umask 077
mkdir "$1" || { echo "Backup directory must not exist" >&2; exit 1; }
backup_dir=$(CDPATH= cd -- "$1" && pwd)
trap 'echo "Backup incomplete; discard the new directory before retrying" >&2' EXIT HUP INT TERM
compose --profile tools run --rm -T --no-deps tools pg_dump --format=custom --no-owner --no-privileges > "$backup_dir/database.dump"
compose --profile tools run --rm -T --no-deps tools tar -C /data/attachments -cf - . > "$backup_dir/attachments.tar"
compose run --rm -T --no-deps worker node scripts/retention.ts export-all --file - > "$backup_dir/redaction-ledger.json"
(cd "$backup_dir" && sha256sum database.dump attachments.tar redaction-ledger.json > SHA256SUMS)
trap - EXIT HUP INT TERM
echo "Backup written to $backup_dir"
