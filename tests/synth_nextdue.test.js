import test from 'node:test';
import assert from 'node:assert/strict';

// Ensure server starts in test mode (prevents probe scheduling noise & uses test seeding paths)
process.env.NODE_ENV = 'test';
const { app } = await import('../src/server.js');
import http from 'node:http';

function startServer(){
  return new Promise(resolve=>{
    const srv = http.createServer(app);
    srv.listen(0, ()=> resolve(srv));
  });
}

async function getJSON(base, path){
  const r = await fetch(base+path, { cache:'no-store' });
  assert.equal(r.ok, true, 'request ok');
  return r.json();
}

/**
 * Verifies that the default seeded synthetic monitor exposes a nextDueAt at least ~30s in the future
 * (it was previously set to immediate which produced an empty/"due" countdown on first UI load).
 */
 test('seeded synthetic nextDueAt is scheduled ahead', async () => {
  const srv = await startServer();
  const { port } = srv.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const j = await getJSON(base, '/synthetics');
    assert.ok(Array.isArray(j.items), 'items array');
    const def = j.items.find(m => /ChatGPT Synthetic Test/i.test(m.name));
    assert.ok(def, 'default synthetic present');
    assert.ok(def.nextDueAt, 'nextDueAt present');
    const now = Date.now();
    const deltaMs = def.nextDueAt - now;
  // Expect nextDueAt roughly 55-65s ahead (1m interval minus small timing). Allow wide window 10s..90s.
  assert.ok(deltaMs > 10000, `nextDueAt should be >10s in future (got ${deltaMs}ms)`);
  assert.ok(deltaMs < 90000, `nextDueAt should be <90s in future (got ${deltaMs}ms)`);
  } finally {
    srv.close();
  }
 });
