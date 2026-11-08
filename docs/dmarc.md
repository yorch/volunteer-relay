# DMARC reporting for the mail domain

The deployment sends mail as the apex domain (`SMTP_FROM=volunteer-relay@brnby.com`), so
DMARC belongs to `brnby.com`, not to the site's subdomain. `volunteer-relay.brnby.com` is a
CNAME and cannot hold TXT records at all — which is also why mail _from_ that subdomain would
fail DMARC, and why no `sp=reject` should be added casually.

## Current record

```
_dmarc.brnby.com  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@brnby.com"
```

`p=none` enforces nothing and collects aggregate reports. Deliberately minimal: `adkim`/`aspf`
already default to relaxed, `pct` is meaningless under `p=none`, and `fo`/`ruf` only affect
forensic reports, which few receivers send and which carry PII.

Supporting records already in place: SPF passes for the sending host (`45.43.208.31`, covered
via `include:mxroute.com` → `forward.mxroute.com`) and DKIM is published at
`x._domainkey.brnby.com`.

## Reading the reports

`infra/production/dmarc-report.py` turns the mailbox into a per-source summary. Reports are
untrusted third-party input, so it refuses DTDs and entity declarations and caps decompressed
size — an aggregate report has no use for either, and both are how XML and archive bombs
arrive. It uses `defusedxml` when the host has it and the guarded parser otherwise.

```sh
# prove the parser works, no mailbox needed
infra/production/dmarc-report.py --self-test

# one report you already have
infra/production/dmarc-report.py --file report.xml.gz

# everything unseen in the reporting mailbox
RELAY_DMARC_ENV_FILE=/opt/volunteer-relay/secrets/dmarc.env \
  infra/production/dmarc-report.py --fetch --mark-seen
```

`--fetch` reads IMAP settings from an env file so a password never reaches `ps` or shell
history:

```dotenv
IMAP_HOST=arrow.mxrouting.net
IMAP_PORT=993
IMAP_USER=dmarc@brnby.com
IMAP_PASSWORD=
IMAP_MAILBOX=INBOX
```

Without `--mark-seen` messages stay unseen and a later run summarises them again. Nothing is
ever sent, deleted or moved.

Output is one row per source and alignment:

```
source ip           count  disposition dkim  spf   header from
45.43.208.31            9  none        pass  pass  brnby.com
203.0.113.9             3  none        fail  fail  brnby.com  <- unaligned
```

`<- unaligned` is the line that matters: a source sending as the domain with neither DKIM nor
SPF aligned is either a legitimate sender you have not authorised (add it to SPF or DKIM) or
someone spoofing the domain.

## Scheduling

Nothing runs this automatically yet. Options, in order of isolation:

1. **Host timer** (`systemd` timer or `cron` on the deployment host) — one weekly run, output
   appended to a log or mailed. Requires a change outside `/opt/volunteer-relay`.
2. **Compose service** — a small profile-scoped service in this project that loops on an
   interval. Everything stays inside the project, but it couples domain reporting to the
   application stack.

## Before tightening the policy

Move to `p=quarantine` only once the summary has shown no unexpected unaligned sources for a
couple of weeks. With `p=none` a mistake is invisible; with `p=quarantine` it is mail in
someone's spam folder. Then change one token:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@brnby.com
```

`p=reject` is the later step, and only after `sp=none` has been considered if anything sends
from subdomains.
