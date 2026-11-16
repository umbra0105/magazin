-- Căutarea în catalog (Faza 7, pasul C): Postgres FTS + pg_trgm, fără motor extern. Doar adăugiri: extensii, o funcție și indexuri.
-- `pg_trgm` și `unaccent` sunt extensii «de încredere» (PostgreSQL 13+): le poate crea și un utilizator fără drepturi de superutilizator,
-- cu dreptul CREATE pe baza de date.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- `unaccent` nu e IMMUTABLE; învelișul de mai jos (rețeta obișnuită) permite folosirea lui în indexuri pe expresii.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- Titlul: potrivire aproximativă (greșeli de scriere, fără diacritice) și căutare de cuvinte cu prefix (autocomplete).
CREATE INDEX "product_title_trgm_idx" ON "product" USING gin (f_unaccent(lower("title")) gin_trgm_ops);
CREATE INDEX "product_title_fts_idx" ON "product"
  USING gin (to_tsvector('simple', f_unaccent(lower("title" || ' ' || coalesce("subtitle", '')))));

-- Codul produsului (SKU) și codul producătorului (piese de schimb): căutare după început de cod.
CREATE INDEX "product_variant_sku_trgm_idx" ON "product_variant" USING gin (f_unaccent(lower("sku")) gin_trgm_ops);
CREATE INDEX "product_variant_mpn_trgm_idx" ON "product_variant"
  USING gin (f_unaccent(lower("manufacturerPartNumber")) gin_trgm_ops);
