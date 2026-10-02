import { test, expect } from '@playwright/test';
import sodium from 'libsodium-wrappers';
import { demoState } from '../../web/demo.js';
import { inZone, nextOccurrence } from '../../web/utils.js';

async function demo(page) {
  await page.goto('/');
  await page.getByRole('button', {name:'Explore the demo'}).click();
  await expect(page.getByRole('heading',{name:'Your content, on autopilot.'})).toBeVisible();
}

test('login gate, demo, and lock preserve no credentials', async ({page}) => {
  await page.goto('/#schedule');
  await expect(page.getByRole('heading',{name:'A space of your own.'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'A little planning. A lot of freedom.'})).toHaveCount(0);
  await demo(page);
  await page.getByRole('button',{name:'Exit demo',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A space of your own.'})).toBeVisible();
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
});

test('generate, edit preview, save and publish only chosen caption', async ({page}) => {
  await demo(page);
  await page.getByRole('button',{name:'Create a post',exact:true}).click();
  await page.getByRole('button',{name:'Generate photo draft'}).click();
  await expect(page.locator('#caption')).toBeVisible();
  // Real library filenames can be much longer than the sample English labels.
  await page.locator('#draft-select').evaluate(select=>{
    select.selectedOptions[0].textContent='שם קובץ בעברית ארוכה מאוד '.repeat(12);
  });
  const controls=await page.locator('.composer-controls').boundingBox();
  const panel=await page.locator('.composer-controls>.panel').first().boundingBox();
  expect(panel.x+panel.width).toBeLessThanOrEqual(controls.x+controls.width+1);
  const caption='A careful caption שלום <script>alert("no")</script>';
  await page.locator('#caption').fill(caption);
  await expect(page.locator('#preview-caption')).toHaveText(caption);
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.locator('#edit-state')).toHaveText('Saved draft');
  await page.getByRole('button',{name:'Publish now'}).click();
  await expect(page.getByRole('dialog')).toContainText('No post will be sent to Facebook');
  await page.getByRole('button',{name:'Simulate publishing'}).click();
  await expect(page.locator('.caption-panel .badge')).toHaveText('Published');
  await expect(page.locator('#preview-caption')).toHaveText(caption);
  await expect(page.getByRole('button',{name:'Publish now'})).toHaveCount(0);
});

test('all post formats, one-time schedule and cancellation work', async ({page}) => {
  await demo(page);
  await page.getByRole('link',{name:'Create a post'}).click();
  for(const type of ['Video','Question']) {
    await page.getByRole('button',{name:type,exact:true}).click();
    await page.getByRole('button',{name:`Generate ${type.toLowerCase()} draft`}).click();
    await expect(page.locator('#caption')).toBeVisible();
    await expect(page.locator('#preview-caption')).not.toBeEmpty();
  }
  await page.getByRole('button',{name:'Schedule post',exact:true}).click();
  await page.locator('#post-date').fill('2099-10-02T10:30');
  await page.getByRole('dialog').getByRole('button',{name:'Schedule post'}).click();
  await expect(page.locator('.caption-panel .badge')).toHaveText('Scheduled');
  await page.locator('#caption').fill('Edited while scheduled');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect(page.locator('.caption-panel .badge')).toHaveText('Scheduled');
  await page.getByRole('button',{name:'Move back to drafts'}).click();
  await expect(page.locator('.caption-panel .badge')).toHaveText('Draft');
});

test('recurring schedule can be created, paused, edited and deleted', async ({page}) => {
  await demo(page);
  await page.getByRole('link',{name:'Schedule',exact:true}).click();
  await page.getByRole('button',{name:'Add a schedule'}).click();
  await page.getByLabel('Schedule name').fill('Evening video');
  await page.getByLabel('Post format').selectOption('video');
  await page.getByLabel('Preferred time').fill('18:30');
  await page.getByLabel('When it’s time').selectOption('publish');
  await expect(page.locator('#mode-hint')).toContainText('without a manual review');
  await page.getByRole('button',{name:'Save schedule'}).click();
  const card=page.locator('.schedule-card').filter({hasText:'Evening video'});
  await expect(card).toContainText('18:30');
  await card.getByRole('switch').click();
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked','false');
  await card.getByRole('button',{name:'Edit Evening video'}).click();
  await page.getByLabel('Schedule name').fill('Evening lesson');
  await page.getByRole('button',{name:'Save schedule'}).click();
  const edited=page.locator('.schedule-card').filter({hasText:'Evening lesson'});
  await expect(edited).toContainText('Paused');
  await edited.getByRole('button',{name:'Edit Evening lesson'}).click();
  await page.getByRole('button',{name:'Delete schedule',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Delete schedule',exact:true}).click();
  await expect(edited).toHaveCount(0);
});

test('Password login, dispatch payload and encrypted secrets use the gateway', async ({page}) => {
  await sodium.ready;
  const keyPair=sodium.crypto_box_keypair();
  const requests=[];
  const initial=demoState();
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const req=route.request();const url=new URL(req.url());requests.push({url:url.pathname,body:req.postData(),auth:req.headers().authorization});
    let body={};
    if(url.pathname.endsWith('/login')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({token:'test-session',repository:'kourgeorge/alfred_posts_automation'})});
    else if(url.pathname.endsWith('/state')) body=initial;
    else if(url.pathname.endsWith('/secrets/public-key')) body={key_id:'mock-key-id',key:sodium.to_base64(keyPair.publicKey,sodium.base64_variants.ORIGINAL)};
    else if(url.pathname.endsWith('/secrets')) body={secrets:[{name:'OPENAI_API_KEY'}]};
    if(req.method()!=='GET') return route.fulfill({status:req.method()==='PUT'?201:204,body:''});
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/');
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio'}).click();
  await expect(page.getByRole('heading',{name:'Your content, on autopilot.'})).toBeVisible();
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await page.getByLabel('API key',{exact:true}).fill('openai-test-secret');
  await page.getByRole('button',{name:'Save credentials'}).click();
  await expect(page.getByLabel('API key',{exact:true})).toHaveValue('');
  const put=requests.find(r=>r.url.endsWith('/secrets/OPENAI_API_KEY')&&r.body);
  expect(put).toBeTruthy();expect(put.body).not.toContain('openai-test-secret');
  const encrypted=JSON.parse(put.body);
  const plain=sodium.crypto_box_seal_open(sodium.from_base64(encrypted.encrypted_value,sodium.base64_variants.ORIGINAL),keyPair.publicKey,keyPair.privateKey,'text');
  expect(plain).toBe('openai-test-secret');
  await page.getByRole('link',{name:'Create a post'}).click();
  await page.getByRole('button',{name:'Generate photo draft'}).click();
  await expect(page.locator('.pending-banner')).toContainText('Creating your draft');
  const sent=JSON.parse(requests.find(r=>r.url.endsWith('/commands')).body);
  expect(sent).toMatchObject({action:'generate',type:'image'});
  expect(requests.filter(r=>!r.url.endsWith('/login')).every(r=>r.auth==='Bearer test-session')).toBeTruthy();
  expect(requests.filter(r=>!r.url.endsWith('/login')).every(r=>!r.body?.includes('test-password'))).toBeTruthy();
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
});

test('Israel local times handle daylight saving changes',()=> {
  expect(inZone('2026-10-02T09:00','Asia/Jerusalem').toISOString()).toBe('2026-10-02T06:00:00.000Z');
  expect(inZone('2026-12-02T09:00','Asia/Jerusalem').toISOString()).toBe('2026-12-02T07:00:00.000Z');
  expect(nextOccurrence({timezone:'Asia/Jerusalem',time:'09:00',days:[4]},new Date('2026-10-02T07:00:00Z')).toISOString()).toBe('2026-10-09T06:00:00.000Z');
});

test('a background update cannot replace the caption or revision being previewed',async({page})=> {
  const remote=demoState();
  const original=remote.drafts[0].text;
  let dispatched;
  await page.clock.install();
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const url=new URL(route.request().url());
    let body={};
    if(url.pathname.endsWith('/login'))body={token:'test-session',repository:'kourgeorge/alfred_posts_automation'};
    else if(url.pathname.endsWith('/state'))body=remote;
    else if(url.pathname.endsWith('/commands')) {dispatched=JSON.parse(route.request().postData());return route.fulfill({status:204,body:''});}
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/');
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio'}).click();
  await page.getByRole('button',{name:/A safer journey starts/}).click();
  await expect(page.locator('#caption')).toHaveValue(original);
  remote.drafts[0].text='Changed in another tab';remote.drafts[0].revision=2;
  await page.clock.fastForward(9000);
  await page.getByRole('button',{name:'Publish now'}).click();
  await page.getByRole('button',{name:'Publish to Facebook',exact:true}).click();
  await expect.poll(()=>dispatched?.text).toBe(original);
  expect(dispatched.revision).toBe(1);
});

for(const width of [1440,390]) test(`visual pages fit ${width}px viewport`,async({page})=> {
  await page.setViewportSize({width,height:1000});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.screenshot({path:`test-results/login-${width}.png`,fullPage:true});
  await demo(page);
  for(const name of ['Overview','Create a post','Schedule','Activity','Settings']) {
    const nav=page.getByRole('link',{name,exact:true});
    if(width<650)await page.getByRole('button',{name:'Toggle navigation'}).click();
    await nav.click();
    await expect(page.locator('h1')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:`test-results/${name.replaceAll(' ','-')}-${width}.png`,fullPage:true});
  }
  expect(errors).toEqual([]);
});


test('wrong password stays locked and an expired session clears private content', async ({page}) => {
  let authorized = false;
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    let body = {error:'Incorrect password. Please try again.'}; let status = 401;
    if (path === '/api/login' && req.postDataJSON().password === 'test-password') {
      body = {token:'test-session',repository:'kourgeorge/alfred_posts_automation'}; status = 200; authorized = true;
    } else if (path === '/api/state' && authorized) { body = demoState(); status = 200; }
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/');
  await expect(page.getByLabel('Password',{exact:true})).toBeVisible();
  await expect(page.getByText('Connection details')).toHaveCount(0);
  await page.getByLabel('Password',{exact:true}).fill('wrong-password');
  await page.getByRole('button',{name:'Open studio'}).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect password');
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio'}).click();
  await expect(page.getByRole('heading',{name:'Your content, on autopilot.'})).toBeVisible();
  await page.getByRole('link',{name:'Activity',exact:true}).click();
  authorized = false;
  await page.getByRole('button',{name:'Refresh status'}).click();
  await expect(page.getByRole('heading',{name:'A space of your own.'})).toBeVisible();
  await expect(page.locator('.draft-row')).toHaveCount(0);
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
});
