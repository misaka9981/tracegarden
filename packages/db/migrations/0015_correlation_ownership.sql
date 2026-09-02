-- Correlation records must never connect entries, suggestions, or Members across Workspaces.
-- Legacy mismatches are reported without rewriting or deleting payloads.
DO $$
DECLARE
  mismatch_count bigint;
  mismatch_details text;
BEGIN
  WITH ownership_mismatches AS (
    SELECT 'suggestion_left_entry' AS relation, suggestions.id AS row_id,
           suggestions.workspace_id, entries.workspace_id AS related_workspace_id,
           suggestions.left_entry_id AS related_id
      FROM tracegarden_correlation_suggestions AS suggestions
      JOIN tracegarden_timeline_entries AS entries ON entries.id = suggestions.left_entry_id
     WHERE entries.workspace_id <> suggestions.workspace_id
    UNION ALL
    SELECT 'suggestion_right_entry', suggestions.id,
           suggestions.workspace_id, entries.workspace_id, suggestions.right_entry_id
      FROM tracegarden_correlation_suggestions AS suggestions
      JOIN tracegarden_timeline_entries AS entries ON entries.id = suggestions.right_entry_id
     WHERE entries.workspace_id <> suggestions.workspace_id
    UNION ALL
    SELECT 'suggestion_decided_by_member', suggestions.id,
           suggestions.workspace_id, members.workspace_id, suggestions.decided_by_member_id
      FROM tracegarden_correlation_suggestions AS suggestions
      JOIN tracegarden_members AS members ON members.id = suggestions.decided_by_member_id
     WHERE suggestions.decided_by_member_id IS NOT NULL
       AND members.workspace_id <> suggestions.workspace_id
    UNION ALL
    SELECT 'confirmed_link_suggestion', links.id,
           links.workspace_id, suggestions.workspace_id, links.suggestion_id
      FROM tracegarden_confirmed_links AS links
      JOIN tracegarden_correlation_suggestions AS suggestions ON suggestions.id = links.suggestion_id
     WHERE suggestions.workspace_id <> links.workspace_id
    UNION ALL
    SELECT 'confirmed_link_left_entry', links.id,
           links.workspace_id, entries.workspace_id, links.left_entry_id
      FROM tracegarden_confirmed_links AS links
      JOIN tracegarden_timeline_entries AS entries ON entries.id = links.left_entry_id
     WHERE entries.workspace_id <> links.workspace_id
    UNION ALL
    SELECT 'confirmed_link_right_entry', links.id,
           links.workspace_id, entries.workspace_id, links.right_entry_id
      FROM tracegarden_confirmed_links AS links
      JOIN tracegarden_timeline_entries AS entries ON entries.id = links.right_entry_id
     WHERE entries.workspace_id <> links.workspace_id
    UNION ALL
    SELECT 'confirmed_link_member', links.id,
           links.workspace_id, members.workspace_id, links.confirmed_by_member_id
      FROM tracegarden_confirmed_links AS links
      JOIN tracegarden_members AS members ON members.id = links.confirmed_by_member_id
     WHERE members.workspace_id <> links.workspace_id
  )
  SELECT count(*), string_agg(
    format('%s id=%s workspace_id=%s related_workspace_id=%s related_id=%s', relation, row_id, workspace_id, related_workspace_id, related_id),
    E'\n' ORDER BY relation, row_id
  )
    INTO mismatch_count, mismatch_details
    FROM ownership_mismatches;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('Migration 0015 blocked: %s legacy correlation Workspace ownership mismatch(es)', mismatch_count),
      DETAIL = mismatch_details,
      HINT = 'No rows were changed. Explicitly reconcile each listed correlation row with its intended Workspace without changing payloads, then rerun migration 0015.';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS tracegarden_members_workspace_id_id_idx
  ON tracegarden_members (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tracegarden_timeline_entries_workspace_id_id_idx
  ON tracegarden_timeline_entries (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tracegarden_correlation_suggestions_workspace_id_id_idx
  ON tracegarden_correlation_suggestions (workspace_id, id);

ALTER TABLE tracegarden_correlation_suggestions
  DROP CONSTRAINT IF EXISTS tracegarden_correlation_suggestions_left_entry_id_fkey,
  DROP CONSTRAINT IF EXISTS tracegarden_correlation_suggestions_right_entry_id_fkey,
  DROP CONSTRAINT IF EXISTS tracegarden_correlation_suggestions_decided_by_member_id_fkey,
  ADD CONSTRAINT tracegarden_correlation_suggestions_workspace_left_entry_fk
    FOREIGN KEY (workspace_id, left_entry_id)
    REFERENCES tracegarden_timeline_entries (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT tracegarden_correlation_suggestions_workspace_right_entry_fk
    FOREIGN KEY (workspace_id, right_entry_id)
    REFERENCES tracegarden_timeline_entries (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT tracegarden_correlation_suggestions_workspace_decided_by_member_fk
    FOREIGN KEY (workspace_id, decided_by_member_id)
    REFERENCES tracegarden_members (workspace_id, id);

ALTER TABLE tracegarden_confirmed_links
  DROP CONSTRAINT IF EXISTS tracegarden_confirmed_links_suggestion_id_fkey,
  DROP CONSTRAINT IF EXISTS tracegarden_confirmed_links_left_entry_id_fkey,
  DROP CONSTRAINT IF EXISTS tracegarden_confirmed_links_right_entry_id_fkey,
  DROP CONSTRAINT IF EXISTS tracegarden_confirmed_links_confirmed_by_member_id_fkey,
  ADD CONSTRAINT tracegarden_confirmed_links_workspace_suggestion_fk
    FOREIGN KEY (workspace_id, suggestion_id)
    REFERENCES tracegarden_correlation_suggestions (workspace_id, id),
  ADD CONSTRAINT tracegarden_confirmed_links_workspace_left_entry_fk
    FOREIGN KEY (workspace_id, left_entry_id)
    REFERENCES tracegarden_timeline_entries (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT tracegarden_confirmed_links_workspace_right_entry_fk
    FOREIGN KEY (workspace_id, right_entry_id)
    REFERENCES tracegarden_timeline_entries (workspace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT tracegarden_confirmed_links_workspace_member_fk
    FOREIGN KEY (workspace_id, confirmed_by_member_id)
    REFERENCES tracegarden_members (workspace_id, id);
