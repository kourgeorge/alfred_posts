// Runs in the private worker, never in the browser. Only model IDs leave it.
import { pathToFileURL } from 'node:url';

export function textModel(id) {
  return typeof id === 'string' && id.length <= 150
    && /^(gpt-\d|o[1-9])/.test(id) && /^[a-zA-Z0-9._-]+$/.test(id)
    && !/(?:audio|realtime|transcribe|tts|image|search|codex|deep-research|instruct|embedding|moderation|oss|(?:^|-)pro(?:-|$))/.test(id)
    && !/^o1-(mini|preview)/.test(id);
}

export async function modelRequest(apiKey, model, request = fetch) {
  if (!apiKey) throw new Error('Set your OpenAI API key in Settings first.');
  const headers = {Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json'};
  const response = await request('https://api.openai.com/v1/models', {headers, signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('Could not load OpenAI models. Check your API key and try again.');
  const result = await response.json();
  if (!Array.isArray(result.data)) throw new Error('OpenAI returned an invalid model list. Try again.');
  const ids = [...new Set(result.data.filter(item=>!item.shutdown_date || item.shutdown_date > new Date().toISOString().slice(0,10))
    .map(item=>item.id).filter(textModel))].sort((a,b)=>a.localeCompare(b, 'en', {numeric:true}));
  if (!ids.length) throw new Error('No text models are available for this OpenAI API key.');
  if (model !== undefined) {
    if (!ids.includes(model)) throw new Error('This model is no longer available. Refresh models and choose again.');
    const check = await request('https://api.openai.com/v1/chat/completions', {
      method:'POST', headers, signal:AbortSignal.timeout(60000),
      body:JSON.stringify({model, max_completion_tokens:32, messages:[
        {role:'system',content:'You write short social media captions.'}, {role:'user',content:'Reply OK.'},
      ]}),
    });
    if (!check.ok) throw new Error('Could not use this model for captions. Check model access and billing, or choose another model.');
    const completion = await check.json();
    if (!Array.isArray(completion.choices) || !completion.choices.length)
      throw new Error('Could not use this model for captions. Check model access and billing, or choose another model.');
  }
  return {ids, refreshed_at:new Date().toISOString()};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await modelRequest(process.env.OPENAI_API_KEY, process.argv[2]))); }
  catch { // Provider errors may contain credentials; never copy them to state or logs.
    console.error('OpenAI model request failed. Check your API key, model access and billing, then try again.');
    process.exitCode = 1;
  }
}
