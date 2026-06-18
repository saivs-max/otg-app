// Managed work-types API (v0.62).
//
// Replaces the hard-coded deployment / retrofit / service / repair enum that
// used to live as a CHECK constraint on work_orders.work_type. Admins can now
// add new work types from the Policy page; the four originals are auto-seeded
// at boot.
//
// Endpoints (manager-only):
//   GET    /api/work-types                — active by default; ?include=archived for all
//   POST   /api/work-types  { name }      — add a new work type
//   PATCH  /api/work-types/:id            — { name? unarchive? } rename or restore
//   DELETE /api/work-types/:id            — soft-archive (rows that use it keep the name)

const express = require('express');
const router  = express.Router();
const { logAudit, DEFAULT_WORK_TYPES } = require('../db');

const MGR_ROLES = new Set(['ops_manager', 'sr_manager', 'pm']);

module.exports = (db) => {

  function requireManager(req, res) {
    const userId = Number(req.header('x-user-id'));
    if (!userId) { res.status(401).json({ error: 'no user selected' }); return null; }
    const me = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId);
    if (!me) { res.status(401).json({ error: 'unknown user' }); return null; }
    if (!MGR_ROLES.has(me.role)) { res.status(403).json({ error: 'manager role required' }); return null; }
    return me;
  }

  router.get('/work-types', (req, res) => {
    // Reads are open to any authenticated user — the WO add/edit form on the
    // tech side needs to populate its work-type picker from this list. Writes
    // (POST/PATCH/DELETE) stay manager-only below.
    const userId = Number(req.header('x-user-id'));
    if (!userId) return res.status(401).json({ error: 'no user selected' });
    const includeArchived = req.query.include === 'archived';
    const rows = db.prepare(`
      SELECT w.id, w.name, w.archived_at, w.created_by, w.created_at,
             u.name AS created_by_name,
             (SELECT COUNT(*) FROM work_orders wo WHERE wo.work_type = w.name) AS use_count
      FROM work_types w
      LEFT JOIN users u ON u.id = w.created_by
      ${includeArchived ? '' : 'WHERE w.archived_at IS NULL'}
      ORDER BY (w.archived_at IS NULL) DESC, w.name COLLATE NOCASE
    `).all();
    res.json(rows);
  });

  router.post('/work-types', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const name = (req.body?.name || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ error: 'name required' });
    if (name.length > 40) return res.status(400).json({ error: 'name too long (max 40 chars)' });
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      return res.status(400).json({ error: 'name must be lowercase letters, digits, dashes, or underscores' });
    }
    try {
      const r = db.prepare("INSERT INTO work_types (name, created_by) VALUES (?, ?)").run(name, me.id);
      logAudit(db, { entity_type: 'work_types', entity_id: r.lastInsertRowid, user_id: me.id, action: 'create', details: { name } });
      res.status(201).json(db.prepare("SELECT * FROM work_types WHERE id = ?").get(r.lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        // Resurrect archived rows with the same name (same pattern as corp_card_categories).
        const existing = db.prepare("SELECT * FROM work_types WHERE name = ?").get(name);
        if (existing && existing.archived_at) {
          db.prepare("UPDATE work_types SET archived_at = NULL, archived_by = NULL WHERE id = ?").run(existing.id);
          return res.json(db.prepare("SELECT * FROM work_types WHERE id = ?").get(existing.id));
        }
        return res.status(409).json({ error: 'work type already exists' });
      }
      throw e;
    }
  });

  router.patch('/work-types/:id', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const id  = Number(req.params.id);
    const row = db.prepare("SELECT * FROM work_types WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: 'not found' });

    const updates = []; const params = [];
    if (typeof req.body?.name === 'string') {
      const n = req.body.name.trim().toLowerCase();
      if (!n) return res.status(400).json({ error: 'name cannot be empty' });
      if (!/^[a-z][a-z0-9_-]*$/.test(n)) return res.status(400).json({ error: 'name must be lowercase letters, digits, dashes, or underscores' });
      updates.push('name = ?'); params.push(n);
    }
    if (req.body?.unarchive === true) {
      updates.push('archived_at = NULL', 'archived_by = NULL');
    }
    if (!updates.length) return res.status(400).json({ error: 'nothing to update' });
    params.push(id);
    try {
      db.prepare(`UPDATE work_types SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'name already in use' });
      throw e;
    }
    logAudit(db, { entity_type: 'work_types', entity_id: id, user_id: me.id, action: 'update', details: req.body });
    res.json(db.prepare("SELECT * FROM work_types WHERE id = ?").get(id));
  });

  router.delete('/work-types/:id', (req, res) => {
    const me = requireManager(req, res); if (!me) return;
    const id  = Number(req.params.id);
    const row = db.prepare("SELECT * FROM work_types WHERE id = ?").get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    // Don't allow archiving one of the four seeded defaults — their abbreviations,
    // productivity rates, and dashboard colors are hard-coded throughout the app.
    if (DEFAULT_WORK_TYPES.includes(row.name)) {
      return res.status(400).json({ error: 'default work types cannot be archived' });
    }
    db.prepare("UPDATE work_types SET archived_at = CURRENT_TIMESTAMP, archived_by = ? WHERE id = ?").run(me.id, id);
    logAudit(db, { entity_type: 'work_types', entity_id: id, user_id: me.id, action: 'archive' });
    res.json({ archived: true });
  });

  // Helper exposed for other route files: the set of currently-active work-type
  // names. Defaults stay accepted even if the work_types table is wiped.
  router.activeWorkTypes = () => {
    const rows = db.prepare("SELECT name FROM work_types WHERE archived_at IS NULL").all();
    const set = new Set(rows.map(r => r.name));
    for (const wt of DEFAULT_WORK_TYPES) set.add(wt); // belt + suspenders
    return set;
  };

  return router;
};
