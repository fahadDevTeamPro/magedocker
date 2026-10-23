# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

Two-repo structure, both git repos:
- Repo root (`.`): Docker infra only — `docker-compose*.yml`, `bin/*`, `env/*`, `Makefile`. Based on Mark Shust's docker-magento.
- `src/`: separate git repo — the actual Magento 2 Commerce (Adobe Commerce) codebase, `2.4.8-p5`. All application code lives here.

Multiple storefronts/brands run from one codebase (ScripCo, AllegroMedical, MassageWarehouse, Advantage Medical, ProMed, etc.), each with its own theme under `src/app/design/frontend/ScripCo/<themeName>` and its own `.magento.env.yaml`/store config. Do not assume a change to one theme applies to all brands.

## Common commands

All `bin/*` commands run from repo root and operate against the running Docker containers (`make help` lists them all):

```
bin/start / bin/stop / bin/restart / bin/status
bin/bash                       # shell into app container
bin/cli <cmd>                  # run any CLI command in container (interactive)
bin/clinotty <cmd>             # same, no TTY (use in scripts/CI-style invocations)
bin/magento <cmd>               # bin/magento CLI
bin/composer <cmd>
bin/mysql / bin/mysqldump
bin/n98-magerun2 <cmd>
bin/redis <cmd>
bin/xdebug enable|disable
bin/build-scrip-hyva [theme...] [--watch] [--no-static] [--skip-install] [--cms]
```

`bin/build-scrip-hyva` builds the Hyvä Tailwind themes (`hyva`, `hyvaAllegroMedical`, `hyvaMassageWarehouse`) and mirrors the production build sequence used in `src/bitbucket-pipelines.yml` (minus deploy/maintenance steps). Use `--watch <theme>` during active Tailwind CSS work on one theme, `--no-static` to skip `setup:static-content:deploy`, `--cms` to also recompile Hyvä CMS JIT CSS.

There is no repo-level test runner beyond standard Magento tooling — no visible custom PHPUnit/lint config. `src/dev` has the usual Magento dev tooling; run tests/static checks the normal Magento way via `bin/cli` (e.g. `bin/cli vendor/bin/phpunit`, `bin/magento dev:tests:run`).

## Deployment

`src/bitbucket-pipelines.yml` defines the QA deploy pipeline (SSHes into Cloudways, `composer install`, `ece-patches apply`, applies a hard-coded hotfix patch, `setup:upgrade`, `deploy:mode:set production`, cache/redis flush). There's also a commented-out `bg-magentohyva` pipeline showing the full production sequence including the Hyvä Tailwind builds per theme — treat that block as the reference for what a full production deploy needs even though it's disabled.

## Custom code architecture

- `src/app/code/ScripCo/*` — ~150+ custom modules, one directory per feature (e.g. `OrderCommentExtended`, `CustomerCredit`, `RequisitionListExtended`, `FraudPrevention`, `Kount360Extend`, `WebhookExtended`). Naming pattern: a module extending/overriding vendor or core Magento functionality is usually suffixed `Extended`; standalone features have plain names. When fixing a bug in checkout/customer/order flows, check for a `ScripCo_*Extended` module before assuming stock Magento behavior — most business logic customizations live here as plugins/preferences on top of Magento core rather than core edits.
- `src/app/design/frontend/ScripCo/*` — per-brand themes. `hyva`, `hyvaAllegroMedical`, `hyvaMassageWarehouse` are the active Hyvä (Tailwind/Alpine, no RequireJS/Knockout) themes; `luma`, `lumaAllegroMedical`, `lumaMassageWarehouse`, `base`, `bwm`, `SH`, `MWH`, `promed`, etc. are legacy Luma themes for other brands/older sites. Each theme dir contains module-scoped overrides (`<theme>/<Vendor>_<Module>/...`) mirroring the module whose templates/layout it overrides — same pattern as stock Magento theme fallback.
- Many `ScripCo_*` modules exist purely to back a matching theme override (e.g. `ScripCo_HidePrice`, `ScripCo_ProductMessage`, `ScripCo_ShippingOnPDP`) — when investigating a frontend behavior, check both the module's own `view/frontend` and the active theme's override directory for that module.
- `src/scripts/` — large collection of one-off/maintenance PHP scripts and CSV data files (customer imports, product data fixes, order corrections, migrations) run ad hoc via `bin/cli php scripts/<name>.php`, not part of the application runtime. Treat anything here as a disposable ops script, not code to refactor or hold to app code standards, unless asked.

## Commits

- Always start the commit subject with the Jira ticket key, e.g. `MPS-17142: Fix set-payment-information sent without reCAPTCHA token`. If no ticket is known, ask for it before committing.
- One-line subject by default; add a body only when the "why" isn't obvious from the subject.

## Notes

- `env/` holds container env files (`db.env`, `magento.env`, `php.ini`, etc.) — the source of truth for local DB/PHP/Redis config, separate from `src/app/etc/env.php` (Magento's own env config, per environment).
- `dbdata/` is the MySQL datadir volume — never treat its contents as source; don't inspect/edit files there directly, use `bin/mysql`.
