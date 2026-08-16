PYTHON ?= python
RUFF ?= ruff
UV ?= uv

.PHONY: check db-backup format lint lock migrate test

db-backup:
	$(PYTHON) scripts/database_backup.py backup

lock:
	$(UV) pip compile requirements.in --python-version 3.11 --output-file requirements.txt
	$(UV) pip compile requirements-dev.in --python-version 3.11 --output-file requirements-dev.txt
	cd web && npm install --package-lock-only --ignore-scripts

migrate:
	cd web && npm run migrate

test:
	$(PYTHON) -m unittest discover -s tests -v
	cd web && npm test

lint:
	$(RUFF) check bot db scripts tests
	cd web && npm run lint

format:
	$(RUFF) format bot db scripts tests
	cd web && npm run format

check: lint test
	$(RUFF) format --check bot db scripts tests
	cd web && npm run format:check
