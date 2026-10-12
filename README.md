<div align="center">

# ⚡ Pulse — Proxy Checker

**A fast, local, open-source desktop proxy checker.**

Check HTTP / HTTPS / SOCKS4 / SOCKS5 proxies, pull fresh ones from public lists, and
keep a maintained pool of your working proxies — with live results, country / quality /
risk data, and **zero API rate limits**.

![Pulse — checking proxies live](docs/screenshots/pulse-results.png)

</div>

---

## Features

- **Three modes** — Paste your own, find **Free Proxies** from public lists, or manage a **Saved** pool.
- **4 protocols** — HTTP, HTTPS, SOCKS4, SOCKS5.
- **Free proxy finder** — pulls thousands of fresh proxies per protocol from public lists and checks which are alive, streaming results **live**.
- **Rich results** — resolved exit IP, country (with flag), quality %, and risk level for every working proxy — all computed **locally** from a bundled IP database. No third-party scoring API, **no rate limits**.
- **Filters** — risk, country, max latency, min quality. Copy / Export / Save respect the active filters.
- **Saved pools** — save working (or filtered) proxies into a persistent per-protocol pool. Recheck anytime, prune dead ones, copy or export.
- **Export** — writes a timestamped `proxies-<scheme>-<date>.txt`.
- **Fully self-contained** — the desktop app bundles everything; end users need nothing installed.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/pulse-paste.png" alt="Paste your proxies"/></td>
<td width="50%"><img src="docs/screenshots/pulse-saved.png" alt="Saved proxy pool"/></td>
</tr>
<tr>
<td align="center"><em>Paste &amp; check any list</em></td>
<td align="center"><em>Maintained saved pool, per protocol</em></td>
</tr>
</table>

## Download

Grab the latest build for your platform from the [**Releases**](../../releases) page:

- **macOS** — `Pulse_x.y.z_aarch64.dmg`
- **Windows** — `Pulse_x.y.z_x64-setup.exe`

> macOS builds are unsigned — on first launch, right-click the app → **Open**
> (or allow it under *System Settings → Privacy & Security*).

## How it works

Pulse is a **Tauri (Rust)** desktop shell with a **Node.js** checking engine and a
**Vite** frontend. For each proxy the engine:

1. connects **through the proxy** to lightweight IP-echo endpoints (rotating, with
   fallback) to confirm it actually forwards traffic and read its **exit IP**;
2. geolocates the exit IP **locally** against a bundled DB-IP Lite database
   (country, ISP, ASN) — no API calls, no limits;
3. computes a **quality %** (latency + anonymity + datacenter detection) and a
   **risk** rating (Low / Medium / High).

## Build from source

Requirements: **Node 18+**, **Rust (stable)**, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
# engine
cd host && npm install && npm test

# frontend
cd ../ui && npm install && npm run build

# desktop app (dev)
cd ../src-tauri && cargo tauri dev
```

To produce a release bundle:

```bash
cd host && npm run pkg                        # self-contained engine binary
cp host/dist/PulseEngine src-tauri/assets/    # stage it as a resource
cd src-tauri && cargo tauri build             # -> .dmg / .exe
```

## Project layout

```
├─ host/          Node.js checking engine (+ bundled GeoIP data)
├─ src-tauri/     Rust / Tauri shell (commands, persistence, window)
├─ ui/            Vite frontend
└─ .github/workflows/release.yml   CI — builds macOS + Windows on a version tag
```

## Releasing

Pushing a version tag triggers CI, which builds the macOS `.dmg` and Windows `.exe`
and attaches them to a GitHub Release:

```bash
git tag v1.0 && git push origin v1.0
```

## Contributing

**Contributions are very welcome!** 🎉 Bug fixes, new proxy-list sources, better
quality/risk heuristics, UI polish, docs — PRs of all sizes are appreciated.

1. Fork the repo and create a branch: `git checkout -b my-feature`
2. Make your change, keep the existing style, and run `cd host && npm test`
3. Open a pull request describing **what** and **why**

Found a bug or have an idea? [Open an issue](../../issues).

## GeoIP data

Country / ISP / ASN lookups use **[DB-IP Lite](https://db-ip.com/db/lite.php)**
(CC-BY) `.mmdb` databases under `host/data/`, refreshable monthly.

## Privacy

All checking happens on your machine. The only network traffic is: fetching public
proxy lists, the proxy connections you ask it to test, and lightweight IP-echo
lookups to read each proxy's exit IP.

## License

[MIT](LICENSE) — free to use, modify, and distribute.
