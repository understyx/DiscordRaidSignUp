-- Migration 020: Custom slugs for recruitment forms
-- Adds an optional unique slug to recruitment_forms so each form can be
-- reached at /recruitment/<slug> in addition to /recruitment/<id>.

ALTER TABLE recruitment_forms ADD COLUMN slug VARCHAR(100) NULL DEFAULT NULL;
ALTER TABLE recruitment_forms ADD UNIQUE INDEX idx_rf_slug (slug);
