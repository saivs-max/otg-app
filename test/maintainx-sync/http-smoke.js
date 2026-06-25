// test/maintainx-sync/http-smoke.js
//
// End-to-end HTTP smoke test for the integration routes. Mounts the real
// routes/integrations.js on an in-memory DB with a STUBBED auth middleware
// (identity normally comes from a validated session) and drives it over HTTP.
//
//   node --experimental-sqlite --no-warnings=ExperimentalWarning test/maintainx-sync/http-smoke.js
process.env.MX_TOKEN_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const assert = require('node:assert');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../../db');

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');
ensureSchema(db);
const uid = Number(db.prepare("INSERT INTO users (name, email, role, worker_type, hourly_rate) VALUES ('W','w@e.com','technician','contractor',40)").run().lastInsertRowid);

const app = express();
app.use(express.json());
// Stub the session → x-user-id step (real middleware validates a Bearer token).
app.use((req, _res, next) => { if (req.headers['x-test-uid']) req.headers['x-user-id'] = req.headers['x-test-uid']; next(); });
app.use('/api', require('../../routes/integrations')(db));

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, method = 'GET', body) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-uid': String(uid) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  let n = 0;
  try {
    let r = await call('/api/integrations/maintainx/status');
    assert.strictEqual(r.json.connected, false, 'status: not connected initially'); n++;

    r = await call('/api/integrations/maintainx/connect', 'POST', { demo: true });
    assert.strictEqual(r.status, 200, 'connect returns 200'); n++;
    assert.strictEqual(r.json.connected, true, 'connect: now connected'); n++;

    r = await call('/api/integrations/maintainx/status');
    assert.strictEqual(r.json.connected, true, 'status: connected after connect'); n++;
    assert.ok(!JSON.stringify(r.json).includes('stub-demo'), 'status never leaks the raw token'); n++;

    r = await call('/api/integrations/maintainx/sync-now', 'POST');
    assert.strictEqual(r.status, 200, 'sync-now 200'); n++;
    assert.strictEqual(r.json.summary.pulled, 5, 'sync-now pulled 5'); n++;
    assert.strictEqual(r.json.summary.laborImported, 4, 'sync-now imported 4 labor times'); n++;

    const woId = db.prepare("SELECT id FROM work_orders WHERE external_id='MX-RTR-900005'").get().id;
    r = await call(`/api/workorders/${woId}/sync-maintainx`, 'POST');
    assert.strictEqual(r.status, 200, 'single WO sync 200'); n++;
    assert.strictEqual(r.json.result.labor.direction, 'pull', 'single WO sync pulled labor'); n++;

    // Unauthenticated request is rejected.
    const rNoAuth = await fetch(base + '/api/integrations/maintainx/status');
    assert.strictEqual(rNoAuth.status, 401, 'no-auth → 401'); n++;

    console.log(`  ✓ HTTP smoke: ${n} assertions passed`);
    server.close();
    process.exit(0);
  } catch (e) {
    console.error(`  ✗ HTTP smoke failed after ${n} assertions:\n      ${e.message}`);
    server.close();
    process.exit(1);
  }
})();
