# Compose + shared-Traefik deployment pattern (survey)

Status: research note for discussion. Not an accepted decision, not an ADR.
Surveyed: 2026-11-08, read-only over `~/code`.
Adversarially reviewed by codex `gpt-6.1-sol`; dispositions in §10.

## 1. Question

volunteer-relay currently ships a **self-contained** production profile: `compose.production.yaml`
runs its own `caddy` container that publishes `80`/`443` and terminates TLS itself
(`infra/production/Caddyfile`, `docs/operations.md`). Several other projects in `~/code`
instead deploy **behind a Traefik instance that already runs on the host**. This note records
how those projects are set up and what adopting the same pattern would actually cost.

## 2. What exists in `~/code`

Two clusters, same idea, different file names — related conventions, not one uniform contract.

### Cluster A — `~/code/docker-compose-services` (infra catalog, ~58 services)

A catalog of self-hosted stacks plus the proxy itself.

| Path                                       | Role                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `traefik3/docker-compose.yml`              | Traefik v3.7 stack: `web`→`websecure` redirect, ACME resolver `webcert` (`tlschallenge`), Docker provider with `exposedbydefault=false`, dashboard on `api@internal` behind basic-auth, `/var/run/docker.sock` mounted |
| `traefik3/setup.sh`                        | `docker network create traefik`                                                                                                                                                                                        |
| `<service>/docker-compose.yml`             | the service: image, `restart: unless-stopped`, env, volumes, healthcheck. _Generally_ no `ports`, no `networks`                                                                                                        |
| `<service>/docker-compose.dev.yml`         | local exposure only: publishes `ports`                                                                                                                                                                                 |
| `<service>/docker-compose.for-traefik.yml` | production exposure only: labels + join external `traefik` network                                                                                                                                                     |
| `mode.sh`                                  | records `COMPOSE_FILE=...` into the service `.env` so plain `docker compose ps/logs/down` work                                                                                                                         |
| `dc.sh`, `dc-dev.sh`, `Taskfile.yml`       | thin wrappers over `docker compose`                                                                                                                                                                                    |

Written down in `docker-compose-services/AGENTS.md` §"Compose file layering" and §"Traefik
overlay shape". The catalog itself documents exceptions, and its own exemplar
(`grafana/docker-compose.for-traefik.yml`) joins **only** `traefik` and uses fixed router names —
single-service stacks do not need the multi-service discipline below.

### Cluster B — application repos

`tradr`, `postbox`, `bizclaw`, `forge-unified-trading`, `nextjs-mvp-super-template`,
`ai-agents-observability`. Each ships `docker-compose.traefik.yml` — same concept, different
name — layered on top of its own prod/infra files:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.infra.yml \
               -f docker-compose.traefik.yml up -d
```

Invoked through a task runner recipe (`just prod-traefik-up`, `prod_traefik := ...`).

## 3. The shared convention

What the multi-service application repos agree on:

1. Traefik runs **outside** the app's Compose project, on an external network named `traefik`.
2. Traefik offers a `websecure` entrypoint and an ACME resolver named `webcert`.
3. The app joins `traefik` **in addition to** its own project network; databases and workers
   stay on the project network only.
4. The app publishes **no host ports** in the Traefik overlay.
5. Routing is declared entirely in labels:

```yaml
services:
  web:
    ports: !reset [] # clear host mappings inherited from the prod file
    networks: [default, traefik]
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=traefik"
      - "traefik.http.services.<name>.loadbalancer.server.port=3000"
      - "traefik.http.routers.<name>.rule=Host(`${DOMAIN_APP:?...}`)"
      - "traefik.http.routers.<name>.entrypoints=websecure"
      - "traefik.http.routers.<name>.tls=true"
      - "traefik.http.routers.<name>.tls.certResolver=webcert"
      - "traefik.http.routers.<name>.service=<name>"

networks:
  traefik:
    external: true
```

6. Names are parameterized (`${TRAEFIK_NAME:-<app>}`) because one Traefik serves many apps.

## 4. Hard-won constraints recorded in those repos

These are the failure modes the pattern already encodes; they are the parts worth copying
verbatim rather than rediscovering.

- **Router-name collisions are not last-write-wins.** `postbox/docker-compose.traefik.yml`:
  "Two stacks that both leave `TRAEFIK_NAME` at the `postbox` default on one Traefik claim the
  same router name, and Traefik resolves that by **dropping BOTH routers**." Two deployments
  (prod + staging, or two tenants) must set the name. The parameterization covers routers and
  services only — middleware names stay provider-global, so a shared `compress`/`auth`
  middleware must either be namespaced per app or be an explicitly host-owned contract.
- **The container port in the label must be a literal.** `postbox`: "Container port, fixed by
  the image — NOT `${PORT}`, which would resolve from the deploy host's shell/.env and render an
  empty label if unset."
- **`${VAR:?}` guards are interpolated before profile filtering.** `postbox`: required-variable
  guards for an optional component (Adminer) live in their own overlay file, otherwise every
  deploy must set variables for a disabled service.
- **Teardown must not need deploy secrets.** `postbox/justfile`: `down` is built from base files
  only, because the Traefik overlays carry `${DOMAIN_APP:?}` guards; `--remove-orphans` catches
  overlay-only services, and `--profile` must be repeated on `down` or a profile-disabled
  container survives.
- **Host port mappings must be cleared explicitly** (`ports: !reset []` or `!override`), or the
  prod file's publish remains and the app is reachable both through Traefik and directly. Both
  are Compose custom merge tags with a minimum Compose version — pin and test on the target host,
  and prove it with an actual inherited mapping (a service that publishes nothing proves nothing).
- **Exactly one proxy hop.** `bizclaw` sets `TRUST_PROXY=1` so client IPs come from
  `X-Forwarded-For`; without it every rate limit keys on Traefik's address. This is a _trust
  policy_, not a flag to copy: anything else on the shared `traefik` network can reach
  `web:3000` directly and supply forged `X-Forwarded-*` headers.
- **Path-based splitting is possible** when one app needs two routers (`bizclaw`: host router for
  the API domain, plus a `PathPrefix(/api|/auth|/oauth|/mcp)` router on the app domain).
- **Middleware is declared by label reference**, e.g. `docker-compose-services` Traefik dashboard
  uses `traefik.http.middlewares.traefik-dashboard-auth.basicauth.users=...`, and
  `dechalaca/docker-stack` reuses a cross-stack `global-auth@docker` middleware — a runtime
  dependency on another stack's configuration and uptime.

## 5. volunteer-relay today

`compose.production.yaml` (P7-03) is a different shape:

| Aspect                 | Current                                                              | Shared-Traefik pattern                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| TLS termination        | bundled `caddy:2.10.2-alpine`, ACME built in                         | host Traefik, resolver `webcert`                                                                                                       |
| Host ports             | `caddy` publishes `80`, `443`, `443/udp`                             | none                                                                                                                                   |
| Edge network           | `edge: {}` (project-local, bridged)                                  | external `traefik`                                                                                                                     |
| Domain source          | `RELAY_DOMAIN` consumed by `Caddyfile`                               | `Host()` label, `DOMAIN_APP`-style var                                                                                                 |
| Certificate state      | named volumes `caddy-data`, `caddy-config`, chowned by `volume-init` | Traefik-owned, outside the project                                                                                                     |
| Default HTTP behaviour | automatic HTTP→HTTPS redirect, HTTP/3 on 443/udp, `encode zstd gzip` | redirect is a Traefik entrypoint config; HTTP/3 needs `443/udp` published on the host proxy; compression needs a `compress` middleware |
| Docker API access      | none                                                                 | the reference Traefik mounts `/var/run/docker.sock`                                                                                    |

Everything else in the profile is orthogonal: `postgres` on `private: {internal: true}`, one-shot
`migrate` + `runtime-grants` gating, read-only root filesystems, `cap_drop: [ALL]`,
`no-new-privileges`, attachments volume, `tools` profile, backup/restore scripts.

The Caddyfile is minimal — `encode` + `reverse_proxy web:3000` — so there is little _app-level_
HTTP configuration to port. That does **not** mean the edge behaviour is equivalent: HSTS,
security headers, body-size limits and rate limits are absent today and would still be absent
after a Traefik move; redirection and HTTP/3 are Caddy defaults that Traefik does not provide
unless configured.

## 6. Adoption options

The options differ mainly in **what the operator is expected to own**, not in YAML size.

### Option 1 — additive overlay, both topologies supported

Keep `compose.production.yaml` exactly as-is and add `compose.traefik.yaml` as an alternative
edge profile, selected per host.

- Real cost: **two supported edge paths** for startup, maintenance, backup, restore, rollback
  and documentation. `infra/production/common.sh` and the runbooks in `docs/operations.md`
  hardcode `-f compose.production.yaml`, and the documented post-backup `up -d` restarts Caddy —
  so "everything else stays the same" is false unless those scripts gain a topology selector.
- Real risk: a profile does not retire a _running_ container. An existing `unless-stopped`
  Caddy keeps `80`/`443` and keeps surviving host restarts; the cutover needs an explicit
  stop/remove step and a rollback step, verified against actual listeners, not a rendered file.
- Justified only if both topologies genuinely must be supported.

### Option 2 — Traefik becomes the only production edge

Remove `caddy` from `compose.production.yaml`, drop `caddy-data`/`caddy-config` volumes and the
Caddyfile, make `traefik` external and required. One topology, one recovery procedure, no
inherited Caddy lifecycle.

- Cost: every host must have Traefik first; `docs/operations.md`, `common.sh`, `backup.sh`,
  `restore.sh` and the P7-03 "self-contained single host" promise all change; certificate state
  moves to the host proxy, where losing `acme.json` affects every app on that host.
- Benefit: no dual maintenance, and the topology the runbooks describe is the topology that runs.

### Option 3 — status quo (default)

Do nothing here. If volunteer-relay is ever deployed onto a host that already runs Traefik,
hand-write a throwaway overlay for that deployment.

- Correct while the deployment target is unconfirmed, or is a dedicated host where the bundled
  Caddy is an asset rather than a conflict.
- The adoption decision is only worth taking once a concrete host is known, because the deciding
  factor is _who owns the proxy on that host_.

**Recommendation: Option 3 now.** Move to Option 2 if and when a shared-Traefik host becomes the
deployment target. Treat Option 1 as a fallback only if both topologies must coexist — the
neighbouring repositories are evidence that the pattern works, not evidence that this project
needs two edge paths.

## 7. Sketch of the overlay (Option 1/2 building block)

```yaml
# compose.traefik.yaml — deploy behind an existing Traefik.
#   docker compose -f compose.production.yaml -f compose.traefik.yaml up -d
# Requires: external network `traefik`, entrypoint `websecure`, resolver `webcert`.
services:
  caddy:
    profiles: ["caddy-disabled"] # only prevents a *fresh* start, not a running container
  web:
    ports: !reset []
    networks: !override [private, traefik] # short lists merge; they do not replace
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=traefik"
      - "traefik.http.services.${TRAEFIK_NAME:-relay}.loadbalancer.server.port=3000"
      - "traefik.http.routers.${TRAEFIK_NAME:-relay}.rule=Host(`${RELAY_DOMAIN:?Set RELAY_DOMAIN}`)"
      - "traefik.http.routers.${TRAEFIK_NAME:-relay}.entrypoints=websecure"
      - "traefik.http.routers.${TRAEFIK_NAME:-relay}.tls=true"
      - "traefik.http.routers.${TRAEFIK_NAME:-relay}.tls.certResolver=webcert"
      - "traefik.http.routers.${TRAEFIK_NAME:-relay}.service=${TRAEFIK_NAME:-relay}"
      - "traefik.http.routers.${TRAEFIK_NAME:-relay}.middlewares=${TRAEFIK_NAME:-relay}-compress"
      - "traefik.http.middlewares.${TRAEFIK_NAME:-relay}-compress.compress=true"
networks:
  traefik:
    external: true
```

Notes on the sketch:

- `web` publishes nothing today, so `ports: !reset []` is defensive, not corrective; the port
  clearing that matters is `caddy`'s, and disabling `caddy` is what removes it.
- `networks: !override` is required if `edge` must actually go away. Without it Compose merges
  the lists and `web` ends up on `{edge, private, traefik}` — routing still works because
  `traefik.docker.network` is explicit, but the documented topology would be a lie.
- `volume-init` still mounts and chowns `caddy-data`/`caddy-config`; remove the mounts _and_ the
  chown operands in this profile, or the unused volumes are still created.
- Compression could equally live on the host proxy; if it does, drop it here and drop the
  middleware name from the router.

## 8. Verification a change like this needs

Rendering config proves almost nothing. A real rehearsal must:

- show the actual running containers and host listeners (`ss`/`docker ps`) — no Caddy, no `:80`
  or `:443` bound by this project;
- inspect `docker network inspect` for `web`, `worker`, `postgres` to prove only `web` is on
  `traefik`, and probe `web:3000` from a peer on the `traefik` network to confirm what is
  reachable;
- run a local Traefik and read _its_ configuration and errors — label typos surface only there —
  using supplied test certificates or an explicitly configured ACME **staging** resolver, not a
  "self-signed resolver" (that is not a thing);
- deploy two complete stacks with different `TRAEFIK_NAME` and prove isolation in both
  directions, including a negative route for the unset/default name;
- send forged `X-Forwarded-For` / `Host` / `X-Forwarded-Proto` both through Traefik and directly
  on the shared network, and check what reaches the app and what rate limiting keys on;
- rehearse the full documented sequence — up, backup, stop, `up -d`, restore, rollback — with the
  topology selector, since `common.sh` and the runbooks otherwise reintroduce Caddy;
- keep public TLS, DNS and certificate issuance as explicitly unverified gates, as with Caddy.

## 9. What this note does not claim

No change is made to `compose.production.yaml`, no deployment is performed, no live Traefik or
public host was touched, and no decision is accepted. The survey is read-only over `~/code`.

## 10. Adversarial review dispositions

Reviewed by codex `gpt-6.1-sol` (read-only, adversarial brief). Verdict: the survey holds, the
original Option 1 recommendation did not.

Accepted and folded in above:

| Finding                                                                                                        | Disposition                                                           |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A profile does not retire a running Caddy; it can keep 80/443 and survive restarts                             | §6 Option 1, §8 — explicit cutover/rollback and listener verification |
| Adding `traefik` does not remove `edge`; Compose merges network lists                                          | §7 — `networks: !override`, corrected topology claim                  |
| `common.sh` and runbooks hardcode `-f compose.production.yaml`; post-backup `up -d` restarts Caddy             | §6 Option 1/2 — topology selection must span maintenance and recovery |
| Shared proxy is a host-wide security/availability dependency; `:ro` on the socket is not read-only API         | §5 table, §6 — proxy ownership is part of the decision                |
| "One proxy hop" is not a client-IP trust policy; shared-network peers can bypass the proxy                     | §4, §8 — trust policy plus forged-header tests                        |
| Certificate ownership/cutover omitted; `acme.json` loss is cross-app; `tlschallenge` is not the HTTP challenge | §4/§5, §8 — staging resolver and cert-state ownership                 |
| `!reset`/`!override` need a pinned, tested Compose version; an empty `ports` proves nothing                    | §4 — pin and prove with a real inherited mapping                      |
| Middleware names are provider-global; `TRAEFIK_NAME` does not namespace them                                   | §4, §7 — namespaced middleware                                        |
| "Converged convention" overstated the catalog's uniformity                                                     | §2, §3 — catalog vs multi-service app conventions separated           |
| Minimal Caddyfile ≠ minimal edge-behaviour change (redirect, HTTP/3, headers)                                  | §5, §8                                                                |
| Removing the chown does not remove the volume mounts                                                           | §7                                                                    |
| §8 verification proved less than its wording implied                                                           | §8 rewritten                                                          |

Confirmed correct by the review: nothing depends on `caddy`; `web` can join `traefik` while
`postgres`/`worker` stay off it; inline `compress=true` with a router `middlewares=` reference is
valid Traefik v3; required-variable interpolation still happens for a profile-disabled service.
