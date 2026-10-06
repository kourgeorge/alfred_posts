import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelRequest, textModel} from '../scripts/openai-models.mjs';

test('discovery uses fresh account models and excludes specialized or shut-down models', async()=> {
  for(const id of ['gpt-4.1-mini','gpt-5-mini','gpt-6-future','o3','o4-mini'])assert.ok(textModel(id),id);
  for(const id of ['gpt-image-1','gpt-4o-audio-preview','gpt-5-pro','gpt-5.2-codex','gpt-4o-search-preview','o3-deep-research','o1-preview','text-embedding-3-small','gpt-4/invalid'])assert.ok(!textModel(id),id);
  const calls=[];
  const request=async(url,options)=> {
    calls.push({url,options});
    return Response.json({data:[{id:'gpt-6-future'},{id:'gpt-4.1-mini'},{id:'gpt-4.1-mini'},
      {id:'gpt-4o',shutdown_date:'2020-01-01'},{id:'gpt-image-1'}]});
  };
  const result=await modelRequest('private-key',undefined,request);
  assert.deepEqual(result.ids,['gpt-4.1-mini','gpt-6-future']);
  assert.equal(calls[0].url,'https://api.openai.com/v1/models');
  assert.equal(calls[0].options.headers.Authorization,'Bearer private-key');
  assert.ok(!JSON.stringify(result).includes('private-key'));
});

test('save validates current account access and the actual caption endpoint', async()=> {
  const calls=[];
  const request=async(url,options)=> {
    calls.push({url,options});
    return Response.json(url.endsWith('/models')?{data:[{id:'gpt-5-mini'}]}:{choices:[{message:{content:'OK'}}]});
  };
  await modelRequest('private-key','gpt-5-mini',request);
  assert.equal(calls[1].url,'https://api.openai.com/v1/chat/completions');
  assert.equal(JSON.parse(calls[1].options.body).model,'gpt-5-mini');
  assert.equal(JSON.parse(calls[1].options.body).messages[0].role,'system');
  calls.length=0;
  await assert.rejects(modelRequest('private-key','gpt-4.1',request),/no longer available/);
  assert.equal(calls.length,1);
  await assert.rejects(modelRequest('private-key','gpt-5-mini',async url=>url.endsWith('/models')?
    Response.json({data:[{id:'gpt-5-mini'}]}):new Response('sensitive provider error',{status:400})),/Could not use this model/);
});

test('discovery errors are safe and an empty catalog cannot be saved', async()=> {
  await assert.rejects(modelRequest('',undefined,()=>assert.fail()),/API key/);
  await assert.rejects(modelRequest('private-key',undefined,async()=>new Response('secret',{status:401})),/Could not load/);
  await assert.rejects(modelRequest('private-key',undefined,async()=>Response.json({data:[]})),/No text models/);
});
