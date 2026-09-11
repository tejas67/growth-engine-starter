ALTER TABLE prospect ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE prospect ADD COLUMN source_note TEXT;
ALTER TABLE touch ADD COLUMN enrolled_at TIMESTAMPTZ;
CREATE TABLE dispatch_attempt (
  touch_id INTEGER PRIMARY KEY REFERENCES touch(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','refused','uncertain')),
  detail TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE FUNCTION protect_demo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'prospect' THEN
    IF OLD.is_demo AND NOT NEW.is_demo THEN RAISE EXCEPTION 'Demo identities cannot become live prospects'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM prospect WHERE id = NEW.prospect_id AND is_demo) THEN
      IF NEW.status IN ('sent','queued') OR NOT NEW.dry_run OR NEW.sent_at IS NOT NULL OR NEW.enrolled_at IS NOT NULL THEN
        RAISE EXCEPTION 'Demo drafts cannot be sent';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_demo_identity BEFORE UPDATE ON prospect FOR EACH ROW EXECUTE FUNCTION protect_demo();
CREATE TRIGGER protect_demo_touch BEFORE INSERT OR UPDATE ON touch FOR EACH ROW EXECUTE FUNCTION protect_demo();
