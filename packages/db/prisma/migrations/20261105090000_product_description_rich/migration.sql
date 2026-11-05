-- 15c, pasul 3: descrierea produsului devine HTML sanitizat (aceeași coloană `product.description`).
--  1. tabela de utilizare media a descrierilor (FK Restrict spre `media`);
--  2. funcția de conversie text simplu → HTML (aceeași regulă ca `plainTextToHtml` din packages/core, comparate de un test);
--  3. migrarea de date: descrierile vechi (text simplu) devin HTML sigur, IDEMPOTENT;
--  4. CHECK: descrierea nu e un șir gol (NULL sau text nevid).

-- CreateTable
CREATE TABLE "product_description_media" (
    "productId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_description_media_pkey" PRIMARY KEY ("productId","mediaId")
);

-- CreateIndex
CREATE INDEX "product_description_media_mediaId_idx" ON "product_description_media"("mediaId");

-- AddForeignKey
ALTER TABLE "product_description_media" ADD CONSTRAINT "product_description_media_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_description_media" ADD CONSTRAINT "product_description_media_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Conversia text simplu → HTML. Regula (aceeași ca `plainTextToHtml`): sfârșiturile de linie se normalizează la \n;
-- paragrafele se despart la una sau mai multe linii «goale» (doar spațiu, tab, FF, VT); liniile unui paragraf se leagă cu
-- <br />; se escapează doar & < >. Text fără nicio linie nevidă → NULL.
CREATE FUNCTION plain_text_to_description_html(input text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  WITH lines AS (
    SELECT u.ord, u.line, (u.line ~ '^[ \t\f\v]*$') AS blank
    FROM unnest(string_to_array(replace(replace(input, E'\r\n', E'\n'), E'\r', E'\n'), E'\n'))
      WITH ORDINALITY AS u(line, ord)
  ),
  grouped AS (
    SELECT ord, line, blank, count(*) FILTER (WHERE blank) OVER (ORDER BY ord) AS grp
    FROM lines
  ),
  paragraphs AS (
    SELECT grp,
           string_agg(replace(replace(replace(line, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '<br />' ORDER BY ord) AS body
    FROM grouped
    WHERE NOT blank
    GROUP BY grp
  )
  SELECT string_agg('<p>' || body || '</p>', '' ORDER BY grp) FROM paragraphs
$$;

-- Migrarea de date (o singură instrucțiune, repetabilă: a doua rulare nu schimbă nimic).
--  - o descriere care deja arată ca HTML-ul produs de conversie (începe cu <p> și se termină cu </p>) rămâne cum e
--    (HTML-ul se sanitizează oricum la scriere și la randare);
--  - orice alt text se convertește, cu escape pentru & < >; textul gol sau doar din spații dă NULL (funcția întoarce
--    NULL când nu există nicio linie nevidă).
-- DATA-MIGRATION-BEGIN
UPDATE "product"
SET "description" = plain_text_to_description_html("description")
WHERE "description" IS NOT NULL
  AND NOT ("description" LIKE '<p>%' AND "description" LIKE '%</p>');
-- DATA-MIGRATION-END

-- Descrierea nu e un șir gol: NULL sau text cu cel puțin un caracter care nu e spațiu ASCII.
ALTER TABLE "product"
  ADD CONSTRAINT "product_description_not_blank_check"
  CHECK ("description" IS NULL OR "description" !~ '^[ \t\n\r\f\v]*$');
