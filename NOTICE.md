# Third-party notices

Pulse itself is released under the [MIT License](LICENSE). It bundles and uses the
following third-party data and software, which carry their own licenses.

## IP geolocation data — DB-IP Lite

Country, ISP, and ASN lookups use the **DB-IP Lite** databases
(`host/data/dbip-country.mmdb`, `host/data/dbip-asn.mmdb`).

> IP Geolocation by DB-IP — <https://db-ip.com>

These databases are licensed under the
[Creative Commons Attribution 4.0 International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
Use (including commercial use) and redistribution are permitted **provided
attribution to DB-IP is given**. Pulse shows the required
"IP Geolocation by DB-IP" credit, linking to db-ip.com, in the application UI.

The MIT license covers Pulse's own source code; it does **not** relicense the
DB-IP data, which remains under CC BY 4.0.

## Proxy list sources

The Free Proxies finder fetches public proxy lists at runtime from the following
community projects (lists are used transiently and never bundled or redistributed):

- **TheSpeedX/PROXY-List** — <https://github.com/TheSpeedX/PROXY-List> (credit requested)
- **monosans/proxy-list** — <https://github.com/monosans/proxy-list> (MIT)
- **proxifly/free-proxy-list** — <https://github.com/proxifly/free-proxy-list> (GPLv3)
- **jetkai/proxy-list** — <https://github.com/jetkai/proxy-list> (MIT)
- **ProxyScrape** — <https://proxyscrape.com> (free API tier)

## Software dependencies

Pulse is built on open-source libraries (Tauri, Node.js, and the npm/crates
dependencies listed in `src-tauri/Cargo.toml`, `host/package.json`, and
`ui/package.json`), each under its own license.
