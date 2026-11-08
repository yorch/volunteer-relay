#!/bin/sh
# Verify the deployment's outbound mail settings, without printing any secret.
#
#   RELAY_RUNTIME_ENV_FILE=/opt/volunteer-relay/secrets/runtime.env \
#     infra/production/check-smtp.sh
#
#   # ...and send a real message, which is the only way to prove delivery
#   RELAY_RUNTIME_ENV_FILE=... infra/production/check-smtp.sh --send-to you@example.org
#
# Checks the transport the application uses: implicit TLS for SMTP_TLS=true,
# STARTTLS otherwise, then AUTH when SMTP_USER is set. Nothing here changes the
# deployment; it opens one connection and closes it.
#
# Requires python3 on the host that runs it (standard on Ubuntu). It is not run
# from inside a container because the application images are bundled: neither
# `nodemailer` nor `@relay/config` resolves as a bare import in them.
set -eu

usage() {
  printf 'Usage: %s [--send-to ADDRESS]\n' "$0"
  printf '       RELAY_RUNTIME_ENV_FILE must point at the runtime env file.\n'
}

send_to=""
case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  --send-to)
    [ "$#" -ge 2 ] || { usage >&2; exit 2; }
    send_to="$2"
    shift 2
    ;;
  "") ;;
  *) usage >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { usage >&2; exit 2; }

: "${RELAY_RUNTIME_ENV_FILE:?Set RELAY_RUNTIME_ENV_FILE to the absolute runtime env file path}"
case "$RELAY_RUNTIME_ENV_FILE" in /*) ;; *) echo "RELAY_RUNTIME_ENV_FILE must be absolute" >&2; exit 1 ;; esac
[ -f "$RELAY_RUNTIME_ENV_FILE" ] || { echo "Runtime env file missing" >&2; exit 1; }
command -v python3 > /dev/null 2>&1 || { echo "python3 is required for this check" >&2; exit 1; }

python3 - "$RELAY_RUNTIME_ENV_FILE" "$send_to" <<'PY'
import smtplib
import ssl
import sys

path, send_to = sys.argv[1], sys.argv[2]
# This is a literal KEY=VALUE reader. Unlike Compose's env_file parser it does
# not strip surrounding quotes or inline comments, so SMTP values in the runtime
# env file must be unquoted and carry no trailing comment; otherwise this check
# can pass or fail on a different value than the containers receive.
cfg = {}
for raw in open(path, encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    cfg[key.strip()] = value.strip()

def fail(message):
    # Never echo a value: only the reason. A provider error can quote the
    # address, not the password, but keep it short and typed regardless.
    print(f"SMTP_CHECK_FAILED: {message}", file=sys.stderr)
    sys.exit(1)

for required in ("SMTP_HOST", "SMTP_PORT", "SMTP_FROM"):
    if not cfg.get(required):
        fail(f"{required} is not set")

host, from_addr = cfg["SMTP_HOST"], cfg["SMTP_FROM"]
try:
    port = int(cfg["SMTP_PORT"])
except ValueError:
    fail("SMTP_PORT is not a number")
secure = cfg.get("SMTP_TLS") == "true"
user, password = cfg.get("SMTP_USER"), cfg.get("SMTP_PASSWORD", "")
context = ssl.create_default_context()

print(f"connecting to {host}:{port} ({'implicit TLS' if secure else 'STARTTLS'})")
try:
    if secure:
        server = smtplib.SMTP_SSL(host, port, context=context, timeout=20)
    else:
        server = smtplib.SMTP(host, port, timeout=20)
        server.ehlo()
        server.starttls(context=context)
        server.ehlo()
    try:
        print(f"tls: {server.sock.cipher()[0]}")
    except Exception:
        print("tls: established")
    if user:
        server.login(user, password)
        print("auth: ok")
    else:
        print("auth: not configured (SMTP_USER unset)")
    if send_to:
        message = (
            f"From: {from_addr}\r\n"
            f"To: {send_to}\r\n"
            "Subject: volunteer-relay SMTP check\r\n"
            "MIME-Version: 1.0\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "\r\n"
            "This is a delivery check from infra/production/check-smtp.sh.\r\n"
        )
        server.sendmail(from_addr, [send_to], message)
        print(f"sent: test message to {send_to}")
    server.quit()
except Exception as error:
    fail(f"{type(error).__name__}: {str(error)[:160]}")

print("SMTP_CHECK_OK")
PY
