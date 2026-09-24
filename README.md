# SCO Workbench

**InterSystems Supply Chain Orchestrator (SCO)** is a supply chain decision intelligence platform
built on the **InterSystems IRIS** data platform. It unifies data across your entire supply chain
ecosystem, delivers end-to-end visibility, performs intelligent analysis, orchestrates business
processes, and assists decision making through data, analytics, and AI. SCO enables supply chain
teams to move from reactive firefighting to proactive, data-driven decision making.

**SCO Workbench** is a UI application which allows application builders to perform common SCO tasks
needed for your supply chain application, such as defining your data model, connecting data sources,
building KPIs and analytics cubes, identifying supply chain risks based on data and client specific
logic, and visualize data and components built in a dashboard — with an optional **AI Assistant**
that walks you through each form. Note that not all SCO features are exposed through SCO Workbench —
refer to the product documentation for the full capabilities of SCO.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [AI Assistant](#ai-assistant)
- [Troubleshooting](#troubleshooting)
- [Learn more](#learn-more)
- [Contributing](#contributing)

## Features

| Page | What you can do |
|---|---|
| **Introduction** | A tour of SCO and the Workbench — what each capability is for, with links to the product documentation. |
| **Load sample data** | Load a ready-made supply chain data set (customers, suppliers, products, orders…) into your instance, so there is real data to build on. Optional — skip it if your instance already holds your own data. |
| **Data Model** | Browse the SCO data model and add your own **custom objects and attributes**. |
| **Data Integration** | Build an ingestion pipeline in a wizard: pick a source (**local file, SFTP/FTP, SQL database, or Amazon S3**), test the connection, map its fields onto an SCO class, then deploy it to your instance. |
| **Analytics Cube** | See every cube in the instance and inspect its structure (measures, dimension → hierarchy → level tree). Create, edit, delete and **build (populate)** your own cubes — measures with aggregates, plus data and multi-level time dimensions. SCO's built-in cubes are shown read-only. |
| **Business KPI** | Full create / read / update / delete for Business KPI definitions: cube, measure, value type, thresholds, issues, MDX conditions and dimensions. |
| **Dashboard** | Assemble tiles and charts over your cubes and KPIs, arrange them by dragging and resizing, and keep the layout. |
| **Issue Management** | Review the issues your KPIs have identified, with their severity and impact. |
| **Business Process**, **Others** | Overviews of SCO capabilities that are not managed in the Workbench — business processes, scenario analysis, ML forecasting, the business-user AI assistant, Track & Trace — each linking to the official documentation. |
| **AI Assistant** | An optional chat panel docked on the right that teaches the Workbench and fills in its forms for you. See [AI Assistant](#ai-assistant). |

## How it works

- **One container.** The frontend, the backend API and the connection to your instance ship in a
  single Docker image. You point it at your SCO instance and open a browser.
- **It works through SCO's own APIs.** The artifacts you create are written into your
  instance the same way you would write them yourself: cube and pipeline classes are compiled into
  your namespace, KPI definitions go through the SCO KPI API, and interoperability hosts are added to
  your production. Everything it creates is an ordinary SCO artifact you can inspect, change or
  remove from the Management Portal, with or without the Workbench.
- **Your credentials stay on the server.** The browser talks only to the Workbench backend, which
  adds the SCO credentials from your `.env` server-side. They are never sent to the browser.

## Requirements

- **Docker** with Compose (Docker Desktop, or Docker Engine plus the `docker compose` plugin).
- **A running SCO instance** the Workbench can reach: its web port (`52773`) and superserver port
  (`1972`) reachable from the machine running Docker, and the name of the namespace you created.
- **An account on that instance** for the Workbench to act as. Grant it superuser privileges to
  unlock every Workbench capability.
- **Optional: access to one Claude provider** for the AI Assistant. Without it the Workbench starts
  normally and every non-AI feature works; only the AI-driven actions stand down, and each one says
  so.

## Quick start

```bash
cp .env.example .env      # then edit .env: your SCO host, namespace and credentials
docker compose up -d --build
```

Open **<http://localhost:3000>**.

Start on **Load sample data** if your instance is empty, then work down the Features list. If you
configured a Claude provider, open the **AI Assistant** with the button at the bottom-right.

To stop it, `docker compose down`. Your sessions and saved integration cases live in a Docker volume
(`workbench-data`), so they survive a restart; `docker compose down -v` deletes them.

## Configuration

All settings are read from `.env` at startup — see **[.env.example](.env.example)** for the
annotated list. `.env` is gitignored; never commit it.

The essentials:

| Variable | Purpose |
|---|---|
| `SCO_HOST` | Where your SCO instance runs. Keep `host.docker.internal` when it runs on the same machine as the Workbench container (including as its own container with published ports); otherwise its hostname or IP. |
| `SCO_WEB_PORT`, `SCO_SUPERSERVER_PORT` | The instance's web and superserver ports (`52773` / `1972` by default). |
| `SCO_NAMESPACE` | **Required** — the name of the namespace you created for SCO. There is no default; the example uses `SC`. |
| `SCO_USER`, `SCO_PASSWORD` | The account the Workbench uses for every call to your instance. |
| `CLAUDE_PROVIDER`, `ANTHROPIC_MODEL` + provider credentials | Only for the AI Assistant. Pick one provider; leave the whole block unset to run without AI. |

Everything else has a working default.

## AI Assistant

The AI Assistant is an optional chat panel built on the **Claude Agent SDK**. Read this section
before using it — it explains what it can change in your environment and what data leaves it.

### What it does

It works in **Guided** mode: it explains the Workbench, answers questions about what already exists
in your instance, and fills in the forms for you while **you** click the final Save, Build or Deploy.
It can guide these tasks end to end:

1. **Build an analytics cube** over one of your data model classes.
2. **Create or update a Business KPI**.
3. **Create a data pipeline** that ingests external data (file, SFTP/FTP, SQL, S3) into an SCO class.
4. **Deploy an interoperability host** onto your running production.
5. **Answer questions about the instance** — which classes, cubes and KPIs exist and how they are
   shaped — by reading your instance rather than guessing.


| Action | Effect on your instance | Reversible? |
|---|---|---|
| Import + compile a class | Writes and compiles ObjectScript source in the namespace. **Overwrites an existing class of the same name**, with no backup of the old source. | Only by restoring the previous source yourself. Treat a name collision as destructive. |
| Build (populate) a cube | Creates or replaces the cube's fact and index tables. Uses CPU and I/O on the SCO server; can run long over a large source table. | Yes — rebuild, or drop the cube's data. |
| Create / update a Business KPI | Writes the definition through the SCO KPI API. An update **overwrites** the previous one; there is no version history. | Update: only by re-entering the old values. |
| Delete a Business KPI | Removes the definition. | **No.** Permanent. |
| Add a host to the production | Adds a config item to the **running** production, **disabled** by default — so configuring a host never starts a workflow on its own. | Yes — remove the item from the Management Portal. |
| **Enable** a host | **Starts the workflow**: it begins reading and moving files, polling SFTP/FTP, querying your source database, fetching from S3, and writing records into SCO. | The host can be disabled again, but **data already ingested and files already moved stay that way.** |

Deploying a pipeline also copies the files you uploaded into your SCO container.

### What leaves your environment

When the AI features run, your configured provider receives: your chat messages; a compact
description of the page you are on and the values in its form; the system prompt and skill
instructions (which include your namespace and port numbers); and the **metadata** the read-only
tools return — class, property, cube, dimension, measure and KPI **names** and types, row **counts**,
production status — plus any ObjectScript generated during the turn.

What the provider does with that (retention, training, region) is governed by **your** contract with
that provider, not by the Workbench. Sessions and the audit trail are stored locally in the
container's volume.

### Choosing a Claude provider

Pick **one** of five deployment options with `CLAUDE_PROVIDER` and set its credentials in `.env`:

| `CLAUDE_PROVIDER` | Provider | Where inference runs |
|---|---|---|
| `bedrock` | Amazon Bedrock | Your AWS account |
| `anthropic` | Anthropic Claude API | Anthropic |
| `claude-aws` | Claude Platform on AWS | Anthropic, billed through AWS Marketplace |
| `vertex` | Google Cloud's Agent Platform (Vertex AI) | Your GCP project |
| `foundry` | Microsoft Foundry (Azure) | Your Azure resource |

`ANTHROPIC_MODEL` is required for every provider and its form differs — a Bedrock inference-profile
id, a plain Claude model id, a Vertex model id, or, on Foundry, **the Azure deployment name you
chose**. [.env.example](.env.example) has a block per provider with the exact variables.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pages show connection errors; logs mention `ECONNREFUSED` to your instance | The container cannot reach your instance. Keep `SCO_HOST=host.docker.internal` when SCO runs on the same machine, and confirm ports `52773` and `1972` are published there. |
| `401`/`403` from your instance | Check `SCO_USER` / `SCO_PASSWORD`, and that the account has rights in `SCO_NAMESPACE`. |
| Pages are empty and cubes/classes are missing | `SCO_NAMESPACE` does not match the namespace you created for SCO. |
| The chat composer says *"Claude key not provided"* | No Claude provider is configured — see [Choosing a Claude provider](#choosing-a-claude-provider). Everything else keeps working. |
| An AI action reports *"Invalid credentials provided for Claude…"* | A provider is configured but your credentials were rejected. A bad credential can only be detected on use, so it surfaces here rather than at startup. |
| Port 3000 is already in use | Change the published port in [docker-compose.yml](docker-compose.yml) (e.g. `"8080:3000"`). |
| `docker compose up` fails to start after an upgrade | Rebuild rather than reusing the old image: `docker compose up -d --build`. |

## Learn more

- [Supply Chain Orchestrator documentation](https://docs.intersystems.com/supplychain20261/csp/docbook/DocBook.UI.Page.cls)
- [InterSystems IRIS documentation](https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls)
- [Claude Code third-party integrations](https://code.claude.com/docs/en/third-party-integrations) —
  the provider matrix behind the AI Assistant

## Contributing

Running the app from source is documented separately:

- [docs/development.md](docs/development.md) — dev environment setup, running in watch mode, the
  test tiers.
- [docs/integration-testing.md](docs/integration-testing.md) — the standard for the live test tiers.
