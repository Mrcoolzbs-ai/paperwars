CREATE TABLE feedback_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number BIGINT GENERATED ALWAYS AS IDENTITY (MINVALUE 1) NOT NULL UNIQUE,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('bug', 'building', 'unit', 'mechanic', 'other')),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_review', 'accepted', 'rejected', 'needs_info', 'implemented')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  payload JSONB NOT NULL
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 40000),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX feedback_tickets_author_idx ON feedback_tickets (author_id, created_at DESC);
CREATE INDEX feedback_tickets_status_idx ON feedback_tickets (status, created_at DESC);
CREATE INDEX feedback_tickets_category_idx ON feedback_tickets (category, created_at DESC);
CREATE INDEX feedback_tickets_updated_idx ON feedback_tickets (updated_at DESC);

CREATE FUNCTION feedback_tickets_protect_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'feedback ticket identity and content are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER feedback_tickets_immutable
BEFORE UPDATE ON feedback_tickets
FOR EACH ROW EXECUTE FUNCTION feedback_tickets_protect_immutable();

CREATE TABLE feedback_ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_role TEXT NOT NULL CHECK (author_role IN ('player', 'admin')),
  kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'status_change')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'internal')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (author_role = 'admin' OR visibility = 'public')
);

CREATE INDEX feedback_ticket_messages_ticket_idx
  ON feedback_ticket_messages (ticket_id, created_at, id);
CREATE INDEX feedback_ticket_messages_author_idx
  ON feedback_ticket_messages (author_id, created_at DESC);
