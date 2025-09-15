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

function post(path, body){
  return new Promise((resolve,reject)=>{
    const data = Buffer.from(JSON.stringify(body||{}));
    const req = http.request({ hostname:'localhost', port, path, method:'POST', headers:{'Content-Type':'application/json','Content-Length':data.length}}, res=>{
      let buf='';res.on('data',d=>buf+=d);res.on('end',()=>resolve({ status:res.statusCode, body:buf }));
    });
    req.on('error',reject);req.write(data);req.end();
  });
}

async function seed(){
  const now = Date.now();
  for(let i=0;i<5;i++){
    store.push({ ts: now - i*1000, endpoint:'/v1/chat/completions', ok:true, status:200, latencyMs: 100+i*5, model:'m', region:'r', tokensPrompt:10, tokensCompletion:5, tokensTotal:15 });
  }
}

test('chat evidence: returns evidence array with logs grounding', async () => {
  await startServer();
  await seed();
  try {
    const res = await post('/ai/chat',{ messages:[{ role:'user', content:'latency and errors summary' }], llm:false });
    assert.equal(res.status,200,'status 200');
    const j = JSON.parse(res.body);
    assert.ok(Array.isArray(j.evidence), 'evidence array present');
    assert.ok(j.evidence.length>0, 'evidence not empty');
    const first = j.evidence[0];
    assert.ok(Object.prototype.hasOwnProperty.call(first,'text'), 'evidence has text');
  } finally { await stopServer(); }
});
