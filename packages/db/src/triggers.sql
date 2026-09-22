-- FR-1.6 / §6.2: published Base Documents are immutable.
-- The first UPDATE that sets published_at is allowed; all later UPDATE/DELETE are rejected.

CREATE OR REPLACE FUNCTION reject_published_base_document_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_base_document AND OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'published base documents cannot be modified or deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_base_document AND OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'published base documents cannot be modified or deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_published_base_documents ON documents;
CREATE TRIGGER trg_protect_published_base_documents
  BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION reject_published_base_document_mutation();
