import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Force DB enable for this test run so seeding logic executes
process.env.ENABLE_DB = '1';

// Re-import server after setting env (node:test runs files in isolation but ensure ordering)
import { app } from '../src/server.js';

function startServer(){
  const server = http.createServer(app);
  return new Promise(resolve=> server.listen(0, ()=> resolve(server)));
}

async function fetchJson(base, path, opts){
  const res = await fetch(base+path, opts);
  const json = await res.json();
  return { res, json };
}

test('default synthetic seeded (or already present) and can be deleted', async () => {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  // List monitors
  const { res: listRes, json: listJson } = await fetchJson(base, '/synthetics');
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listJson.items));
  // Find ChatGPT seed or create one manually if not present (race safety)
  let seed = listJson.items.find(m=> /ChatGPT Synthetic Test/i.test(m.name||''));
  if (!seed) {
    const spec = { name:'ChatGPT Synthetic Test', schedule:'every_1m', startUrl:'https://chatgpt.com', timeoutMs:20000, steps:[ { action:'goto', url:'https://chatgpt.com' }, { action:'asserttextcontains', selector:'body', text:'', any:true } ] };
    const create = await fetchJson(base, '/synthetics', { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ spec }) });
    assert.equal(create.res.status, 200);
    seed = { id: create.json.id };
  }
  assert.ok(seed && seed.id, 'Seed synthetic should exist');
  // Delete it
  const del = await fetchJson(base, `/synthetics/${seed.id}`, { method:'DELETE' });
  assert.equal(del.res.status, 200);
  // Confirm it is soft deleted (should not appear without deleted=1)
  const after = await fetchJson(base, '/synthetics');
  assert.equal(after.res.status, 200);
  const still = after.json.items.find(m=> m.id === seed.id);
  assert.ok(!still, 'Deleted synthetic should not appear in default list');
  server.close();
});
