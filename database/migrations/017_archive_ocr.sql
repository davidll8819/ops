-- Preserve originals and successful extractions; only retryable derivatives gain OCR.
ALTER TABLE archive_documents DROP CONSTRAINT archive_documents_kind_check;
ALTER TABLE archive_documents ADD CONSTRAINT archive_documents_kind_check CHECK(kind IN ('docx','pdf','xlsx','image'));
ALTER TABLE archive_documents ADD COLUMN progress jsonb;
ALTER TABLE archive_documents ADD CONSTRAINT archive_documents_progress_check CHECK(progress IS NULL OR (state='processing' AND jsonb_typeof(progress)='object'));
CREATE OR REPLACE FUNCTION archive_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF OLD.state='ready' THEN RAISE EXCEPTION 'Successful archive extractions are immutable'; END IF;
  IF (to_jsonb(OLD)-ARRAY['state','kind','attempt_id','attempts','lease_until','error','warnings','blocks','stats','updated_at','parser_version','progress'])
   IS DISTINCT FROM
   (to_jsonb(NEW)-ARRAY['state','kind','attempt_id','attempts','lease_until','error','warnings','blocks','stats','updated_at','parser_version','progress'])
  THEN RAISE EXCEPTION 'Archive source identity is immutable'; END IF;
  RETURN NEW;
 END
$$;
