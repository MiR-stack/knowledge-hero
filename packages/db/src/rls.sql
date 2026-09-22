-- Row-level security policies per docs/SRS.md §6.2.
-- FORCE ROW LEVEL SECURITY ensures the table owner (application role) is subject to RLS.

-- Direct workspace_id tables
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON folders
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

ALTER TABLE batch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON batch_jobs
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_chunks
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

ALTER TABLE scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scopes
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_members
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

ALTER TABLE workspace_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_rate_limits
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

ALTER TABLE workspace_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_usage_events
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_sessions
  FOR ALL
  USING (workspace_id = current_setting('app.current_workspace', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace', true)::uuid);

-- Indirect workspace_id via parent tables
ALTER TABLE folder_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON folder_permissions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM folders f
      WHERE f.id = folder_permissions.folder_id
        AND f.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM folders f
      WHERE f.id = folder_permissions.folder_id
        AND f.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  );

ALTER TABLE scope_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scope_documents
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM scopes s
      WHERE s.id = scope_documents.scope_id
        AND s.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM scopes s
      WHERE s.id = scope_documents.scope_id
        AND s.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  );

ALTER TABLE scope_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_folders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scope_folders
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM scopes s
      WHERE s.id = scope_folders.scope_id
        AND s.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM scopes s
      WHERE s.id = scope_folders.scope_id
        AND s.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  );

ALTER TABLE scope_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scope_shares
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM scopes s
      WHERE s.id = scope_shares.scope_id
        AND s.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM scopes s
      WHERE s.id = scope_shares.scope_id
        AND s.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  );

ALTER TABLE scope_resolved_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_resolved_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON scope_resolved_documents
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM scopes s
      WHERE s.id = scope_resolved_documents.scope_id
        AND s.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM scopes s
      WHERE s.id = scope_resolved_documents.scope_id
        AND s.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  );

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_messages
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions cs
      WHERE cs.id = chat_messages.session_id
        AND cs.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM chat_sessions cs
      WHERE cs.id = chat_messages.session_id
        AND cs.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  );

ALTER TABLE chat_message_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_message_citations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_message_citations
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM chat_messages cm
      JOIN chat_sessions cs ON cs.id = cm.session_id
      WHERE cm.id = chat_message_citations.message_id
        AND cs.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM chat_messages cm
      JOIN chat_sessions cs ON cs.id = cm.session_id
      WHERE cm.id = chat_message_citations.message_id
        AND cs.workspace_id = current_setting('app.current_workspace', true)::uuid
    )
  );
