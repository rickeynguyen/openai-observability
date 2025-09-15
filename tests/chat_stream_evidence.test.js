import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { app, store } from '../src/server.js';

let server; let port;
async function startServer(){
  server = http.createServer(app);
  await new Promise(res=> server.listen(0,res));
  port = server.address().port;
}
async function stopServer(){ if(server){ server.close(); await new Promise(r=>setTimeout(r,50)); } }

function postStream(path, body){
  return new Promise((resolve,reject)=>{
    const data = Buffer.from(JSON.stringify(body||{}));
    const req = http.request({ hostname:'localhost', port, path, method:'POST', headers:{'Content-Type':'application/json','Content-Length':data.length}}, res=>{
      let chunks='';
      res.on('data',d=>{ chunks+=d.toString('utf8'); });
      res.on('end',()=> resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error',reject); req.write(data); req.end();
  });
}

async function seed(){
  const now = Date.now();
  for(let i=0;i<3;i++){
    store.push({ ts: now - i*500, endpoint:'/v1/chat/completions', ok:true, status:200, latencyMs: 100+i*10, model:'m', region:'r', tokensPrompt:5, tokensCompletion:5, tokensTotal:10 });
  }
}

test('chat stream evidence: final NDJSON includes evidence', async () => {
  await startServer();
  await seed();
  try {
    const res = await postStream('/ai/chat/stream',{ messages:[{ role:'user', content:'give latency summary' }], llm:false });
    assert.equal(res.status,200,'status 200');
    const lines = res.body.trim().split(/\n+/).filter(Boolean);
    assert.ok(lines.length>0,'has lines');
    const last = JSON.parse(lines[lines.length-1]);
    assert.equal(last.done,true,'done true');
    assert.ok(Array.isArray(last.evidence),'evidence present');
    assert.ok(last.evidence.length>0,'evidence not empty');
    assert.ok(Object.prototype.hasOwnProperty.call(last.evidence[0],'text'),'evidence[0].text');
  } finally { await stopServer(); }
});
