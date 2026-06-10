# AGENTS.md

This repository is a Docomo Bike Share data collection and dashboard project.
Use this file as the agent-facing operating manual.

## What This Project Does
- Scrapes vehicle and station-related data from the management system and GBFS sources.
- Generates dashboard artifacts such as `dashboard_data.json` and `dashboard_data.js`.
- Serves a small Flask API for worker location data and uploads it to R2.
- Provides a Leaflet-based dashboard in the browser.

## Working Rules
- Prefer small, local changes that match the existing repo style.
- Do not edit `.env` or commit secrets.
- Treat generated outputs in `output/` and `dashboard_data.*` as build artifacts unless the task is specifically about them.
- Avoid deleting historical CSV outputs unless the user explicitly asks.
- Keep changes scoped to the files needed for the task.
- If you touch browser-facing code, verify the affected path with the local app or tests when feasible.

## Encoding Rules
- Default to UTF-8 when reading, editing, or creating text files.
- If a file already uses a different encoding, inspect before rewriting it so we do not corrupt existing content.
- When Japanese text looks garbled, confirm the actual file encoding rather than assuming the text itself is wrong.
- Prefer line-level fixes over bulk rewrites when the issue is localized.
- After fixing encoding-related text, re-open the file in UTF-8 and verify the rendered Japanese is correct.

## Useful Commands
- Run tests: `pytest`
- Regenerate dashboard data from the latest local CSV: `DBS_RUN_MODE=MAP_DATA_ONLY python main.py`
- Run the worker-location API: `python server.py`

## Key Files
- `main.py`: scraping and dashboard generation entry point
- `server.py`: Flask API for worker locations
- `src/dashboard_generator.py`: CSV to dashboard transformation
- `index.html`, `main.js`, `js/`, `style.css`: dashboard frontend

