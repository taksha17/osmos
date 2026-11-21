# OSMOS self-hosting guide — Web Access (v3)

OSMOS never bundles a crawler. You run the Firecrawl-compatible service on your
own machine; OSMOS only speaks HTTP to it. Fully local = **Firecrawl (fetch) +
SearXNG (search)** — Firecrawl search defaults to cloud, so pair it explicitly.

## Option A — Firecrawl Local binary (recommended for laptops)

- Install: `cargo install firecrawl-local` (needs Rust + C compiler; Chrome/Chromium optional for JS pages; Node 22+ optional for MCP).
- Run: `firecrawl-local` → serves the v2 API on `http://127.0.0.1:3002`.
- Footprint: ~11–14 MB idle. Nothing to configure for OSMOS: Settings → Web access → Enable → Tier `Firecrawl Local` → Test.
- Windows box layout (this project): `D:\osmos-web\firecrawl-local\` (or `E:\` if D: is full). Never use `C:\`. Pin the binary version + SHA; record it in the Test output.

## Option B — Full Docker Compose stack (server / second PC)

Services: `api`, `playwright-service`, `redis`, `rabbitmq`, `nuq-postgres`. Needs Git + Docker Engine/Desktop + Compose v2.

```bash
git clone https://github.com/firecrawl/firecrawl.git
cd firecrawl
git checkout $(git describe --tags --abbrev=0)
cat > .env <<'EOF'
USE_DB_AUTHENTICATION=false
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<32+ random chars>
POSTGRES_DB=postgres
EOF
docker compose up --build -d
```

Hardware: minimum 4 vCPU / 8 GB RAM / 5 GB disk; recommended 8+ vCPU / 12–16 GB (API ~8 GB, Playwright ~4 GB + Redis/RabbitMQ/Postgres). Idle ~2.5 GB. Do NOT co-run with a large local LLM on a 16 GB box without expecting memory pressure. Windows box layout: `D:\osmos-web\firecrawl-stack\` (compose project there, `.env` beside it).

Security: bind `127.0.0.1:3002` only. If a LAN bind is needed, set a bearer key and firewall it; the OSMOS Test button warns when auth is off on a non-loopback bind. Respect `robots.txt`, ≥1 s per-domain delay, and site terms.

## Reaching the Windows box from Linux dev

Keep the service on loopback on Windows and forward it — do not expose the LAN port:

```bash
ssh -L 3002:localhost:3002 <user>@<host>
curl -s http://127.0.0.1:3002/   # expect a version/health payload
```

Then OSMOS Base URL stays `http://127.0.0.1:3002`. LAN/remote mode (Base URL = `http://<host>:3002` + API key) is only for a trusted LAN with auth on.

## Optional local search (one command)

```bash
docker run -d -p 127.0.0.1:8080:8080 searxng/searxng
```

Point OSMOS search source at `http://127.0.0.1:8080`. Without this, search still uses DuckDuckGo/Tavily per existing settings.

## Licence note

Firecrawl is AGPL-3.0 and stays a separate process you run — OSMOS does not vendor, link, or copy its code (see `THIRD-PARTY-NOTICES.md`).
