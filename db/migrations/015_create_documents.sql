-- Relay migration 015: documents and document categories
-- (ticket abe5fa10; design doc ch. 17): a filing cabinet for the
-- documents the platform produces. The inventory for this ticket found
-- the platform currently generates no files at all — no download or
-- export code anywhere, and 「產生規格書」 is only a workflow state
-- label in the example flows, not a generator — so v1 is a registry:
-- documents are filed here with title, category and markdown content
-- stored in the database, and download renders the stored content as
-- a .md file on the fly (no file store). Categories are user-defined
-- data, seeded with the two defaults below; new ones are added from
-- the Document page and stored here, not in frontend state.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS document_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_categories_name ON document_categories (name);

INSERT INTO document_categories (name, created_by)
SELECT 'Prototype', 'system'
WHERE NOT EXISTS (SELECT 1 FROM document_categories WHERE name = 'Prototype');

INSERT INTO document_categories (name, created_by)
SELECT 'Undefined', 'system'
WHERE NOT EXISTS (SELECT 1 FROM document_categories WHERE name = 'Undefined');

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  category_id UUID NOT NULL REFERENCES document_categories(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_documents_project ON documents (project_id);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents (category_id);
CREATE INDEX IF NOT EXISTS idx_documents_created ON documents (created_at, id);
