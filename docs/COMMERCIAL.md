# Aries AI — Commercial and Open-Source Terms

## What is open source

The Aries AI application in this repository is released under the **Apache License 2.0**. You may use, modify, and distribute the source code under the terms of that license.

Open-source components include:

- The Next.js App Router application (`app/`, `components/`, `lib/`, `hooks/`)
- Backend domain logic (`backend/`)
- Database initialization scripts (`scripts/init-db.js`)
- Docker and Compose configuration (`Dockerfile`, `docker-compose.yml`, `docker-compose.local.yml`)
- Environment template (`.env.example`)
- Tests and validation scripts (`tests/`, `scripts/`)

## What is not included

The following are **not** part of this open-source release:

- **Hermes** — the AI workflow execution engine that Aries submits runs to. Hermes is a separate service developed and operated by Sugar & Leather, LLC. This repository contains only the client-side adapter code that calls the Hermes gateway API; the Hermes server itself is not open-source.
- **Managed cloud hosting** — the production instance of Aries AI at [aries.sugarandleather.com](https://aries.sugarandleather.com) is operated by Sugar & Leather, LLC and is not covered by this open-source license.
- **Paid support and SLA** — commercial support agreements, SLA-backed deployments, and professional services are available separately.
- **Proprietary automation scripts** — internal automation scripts that interact with the production environment, internal dashboards, or confidential customer data are not included.

## Self-hosting

You are free to self-host Aries AI under the Apache 2.0 license. You will need to provide your own:

- PostgreSQL database
- Hermes gateway instance (contact Sugar & Leather, LLC for access)
- OAuth app registrations for the social providers you want to connect
- Transactional email provider (Resend or compatible)

See `SELF_HOSTING.md` for setup instructions and `DEPLOYMENT.md` for production deployment.

## Managed hosting and paid support

Sugar & Leather, LLC offers:

- **Managed cloud hosting** — fully managed Aries AI instances with Hermes included, monitored infrastructure, and regular updates.
- **Paid support** — priority support, custom integrations, and SLA-backed assistance.

Contact: **hello@sugarandleather.com**

## Trademark

"Aries AI" and "Sugar & Leather" are names used by Sugar & Leather, LLC. The Apache 2.0 license grants you rights to the source code but does not grant rights to use these names in ways that imply endorsement or official affiliation without prior written permission.

## Sponsorship

If Aries AI is useful to you, consider supporting its development:

- GitHub Sponsors: [github.com/sponsors/DeliciousHouse](https://github.com/sponsors/DeliciousHouse)

Sponsor contributions fund open-source development, documentation, and community support.

## License

```
Copyright 2024–2026 Sugar & Leather, LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
