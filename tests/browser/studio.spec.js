import { test, expect } from '@playwright/test';
import sodium from 'libsodium-wrappers';
import { demoState, demoCommand } from '../../web/demo.js';
import { inZone, nextOccurrence, scheduleRun } from '../../web/utils.js';
import defaultPrompts from '../../prompts.json' with { type: 'json' };
import { activityItems, filterActivity } from '../../web/activity.js';

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
  expect(inZone('2026-11-01T01:30','America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z');
  expect(()=>inZone('2026-03-08T02:30','America/New_York')).toThrow('does not exist');
});

test('pending recurring slots stay visible until claimed or expired',()=> {
  const schedule={id:'sat',enabled:true,timezone:'Asia/Jerusalem',time:'10:10',days:[5],starts_at:'2026-10-03T07:06:46Z'};
  expect(scheduleRun(schedule,[],new Date('2026-10-03T07:09:00Z'))).toBeNull();
  expect(scheduleRun(schedule,[],new Date('2026-10-03T07:15:00Z')).status).toBe('waiting');
  expect(scheduleRun(schedule,[],new Date('2026-10-03T10:19:00Z')).status).toBe('overdue');
  expect(scheduleRun(schedule,[],new Date('2026-10-04T07:10:00Z')).status).toBe('overdue');
  expect(scheduleRun(schedule,[],new Date('2026-10-04T07:10:01Z')).status).toBe('missed');
  expect(scheduleRun({...schedule,enabled:false},[],new Date('2026-10-03T10:19:00Z'))).toBeNull();
  expect(scheduleRun({...schedule,starts_at:'2026-10-03T08:00:00Z'},[],new Date('2026-10-03T10:19:00Z'))).toBeNull();
});

test('manual schedule check reviews due work, dispatches once and reports completion',async({page})=> {
  const remote=demoState();
  remote.schedules=[{id:'due-photo',name:'Due recurring photo',type:'image',mode:'publish',enabled:true,
    timezone:'Asia/Jerusalem',time:'10:10',days:[5],starts_at:'2026-10-03T07:06:46Z'}];
  remote.drafts[0].status='scheduled';remote.drafts[0].scheduled_at='2026-10-03T07:00:00Z';
  remote.drafts[0].text='My prepared caption';
  remote.drafts[1].status='scheduled';remote.drafts[1].scheduled_at='2099-10-03T07:00:00Z';
  const sent=[];
  await page.clock.install({time:new Date('2026-10-03T10:19:00Z')});
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const request=route.request();const path=new URL(request.url()).pathname;
    if(path==='/api/commands') {
      sent.push(request.postDataJSON());
      return route.fulfill({status:204,body:''});
    }
    const body=path==='/api/login'?{token:'test-session',repository:'kourgeorge/alfred_posts_automation'}:remote;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/#schedule');
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio'}).click();
  await page.getByRole('button',{name:'Run due tasks now',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('Due recurring photo');
  await expect(dialog).toContainText('Publish saved post');
  await expect(dialog).not.toContainText(remote.drafts[1].source.name);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(sent).toHaveLength(0);
  await page.getByRole('button',{name:'Run due tasks now',exact:true}).click();
  await dialog.getByRole('button',{name:'Run due tasks',exact:true}).click();
  await expect(page.locator('.pending-banner')).toContainText('Running due tasks');
  await expect(page.getByRole('button',{name:'Run due tasks now',exact:true})).toBeDisabled();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({action:'run_due',id:expect.any(String)});
  remote.drafts[0].status='published';
  remote.scheduler={last_finished_at:'2026-10-03T10:20:00Z'};
  remote.operations.unshift({id:sent[0].id,action:'run_due',status:'complete'});
  await page.clock.fastForward(9000);
  await expect(page.locator('.pending-banner')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('Schedule check finished');
  await expect(page.getByRole('button',{name:'Run due tasks now',exact:true})).toBeEnabled();
  expect(remote.drafts[0].text).toBe('My prepared caption');
});

test('manual schedule check simulates safely in the demo',async({page})=> {
  await demo(page);
  await page.getByRole('link',{name:'Schedule',exact:true}).click();
  await page.getByRole('button',{name:'Run due tasks now',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('No post will be sent to Facebook');
  await page.getByRole('button',{name:'Simulate due tasks',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('Schedule check finished');
  await expect(page.locator('.schedule-info')).toContainText('Last completed check:');
});

test('demo manual check preserves saved captions and skips future posts',()=> {
  const state=demoState();
  state.schedules=[];
  Object.assign(state.drafts[0],{status:'scheduled',scheduled_at:'2020-01-01T00:00:00Z',text:'Reviewed caption'});
  Object.assign(state.drafts[1],{status:'scheduled',scheduled_at:'2099-01-01T00:00:00Z'});
  demoCommand(state,{action:'run_due',id:'demo-run-001'});
  demoCommand(state,{action:'run_due',id:'demo-run-002'});
  expect(state.drafts[0]).toMatchObject({status:'published',text:'Reviewed caption',revision:2});
  expect(state.drafts[1].status).toBe('scheduled');
  expect(state.drafts[2].status).toBe('draft');
});

test('Activity keeps future schedules separate from missed and overdue work needing attention',async({page})=> {
  const remote=demoState();
  await page.clock.install({time:new Date('2026-10-03T10:19:00Z')});
  remote.schedules=[{id:'future',name:'Morning driving tips',type:'image',mode:'draft',enabled:true,days:[0],time:'09:00',timezone:'Asia/Jerusalem',starts_at:'2026-10-03T07:00:00Z'},
    {id:'overdue',name:'Overdue recurring photo',type:'image',mode:'publish',enabled:true,days:[5],time:'10:10',timezone:'Asia/Jerusalem',starts_at:'2026-10-03T07:00:00Z'}];
  const caption='Published caption שלום <script>not executable</script>';
  Object.assign(remote.drafts[0],{status:'published',text:caption,preview:'data:image/jpeg;base64,/9j/2Q==',published_at:'2026-10-03T09:00:00Z',facebook_url:'https://www.facebook.com/page_post'});
  Object.assign(remote.drafts[1],{status:'scheduled',scheduled_at:'2099-01-01T10:00:00Z'});
  Object.assign(remote.drafts[2],{status:'scheduled',scheduled_at:'2026-10-03T07:00:00Z'});
  remote.missed_runs=[{id:'missed-run-1',schedule_id:'deleted-schedule',slot:'2026-10-02@10:10',name:'A missed photo',type:'image',mode:'publish',scheduled_at:'2026-10-02T07:10:00Z',status:'missed'}];
  let sent;
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const req=route.request();const path=new URL(req.url()).pathname;
    if(path==='/api/commands') {
      sent=req.postDataJSON();
      demoCommand(remote,sent);
      return route.fulfill({status:204,body:''});
    }
    const body=path==='/api/login'?{token:'test-session',repository:'kourgeorge/alfred_posts_automation'}:remote;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/#activity');
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio'}).click();
  await page.getByRole('button',{name:/^Published/}).click();
  await expect(page.locator('.activity-post')).toHaveCount(2);
  const post=page.locator('[data-post-id="demo-photo"]');
  await expect(post.locator('.activity-caption')).toHaveText(caption);
  await expect(post.locator('img')).toHaveCount(1);
  await expect(post.locator('script')).toHaveCount(0);
  await expect(post.getByRole('link',{name:'View on Facebook'})).toBeVisible();
  await page.getByRole('button',{name:/^Scheduled/}).click();
  await expect(page.locator('[data-post-id="demo-video"]')).toBeVisible();
  await expect(page.getByText('Morning driving tips',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/^Needs attention/}).click();
  await expect(page.locator('[data-post-id="demo-video"]')).toHaveCount(0);
  await expect(page.getByText('Morning driving tips',{exact:true})).toHaveCount(0);
  await expect(page.getByText('A missed photo',{exact:true})).toBeVisible();
  await expect(page.getByText('Overdue recurring photo',{exact:true})).toBeVisible();
  await expect(page.locator('[data-post-id="demo-question"] .badge')).toHaveText('Overdue');
  await expect(page.locator('[data-post-id="demo-photo"]')).toHaveCount(0);
  await page.getByRole('button',{name:'Prepare missed draft',exact:true}).click();
  await expect(page.locator('#caption')).toBeVisible();
  expect(sent).toMatchObject({action:'recover_missed',missed_id:'missed-run-1'});
  expect(remote.missed_runs[0].status).toBe('draft');
  expect(remote.drafts.filter(d=>d.status==='published')).toHaveLength(2);
});

test('missed tasks remain visible after recovery without duplicate rows',()=> {
  const state=demoState();
  state.schedules=[{id:'old',name:'Old schedule',type:'image',mode:'publish',enabled:true,days:[5],time:'10:10',timezone:'Asia/Jerusalem',starts_at:'2026-10-03T07:00:00Z',last_missed_slot:'2026-10-03@10:10'}];
  state.missed_runs=[{id:'missed',schedule_id:'old',slot:'2026-10-03@10:10',name:'Old schedule',type:'image',mode:'publish',scheduled_at:'2026-10-03T07:10:00Z',status:'missed'}];
  const now=new Date('2026-10-04T08:00:00Z');
  expect(filterActivity(activityItems(state,now),'attention').filter(x=>x.status==='missed')).toHaveLength(1);
  demoCommand(state,{id:'recover-test',action:'recover_missed',missed_id:'missed'});
  const items=filterActivity(activityItems(state,now),'attention');
  expect(items.filter(x=>x.kind==='post')).toHaveLength(1);
  expect(items.filter(x=>x.status==='missed')).toHaveLength(0);
  state.schedules=[];state.operations=[];
  expect(filterActivity(activityItems(state,now),'attention')).toHaveLength(1);
  const recovered = state.drafts.find(d=>d.missed_run_id==='missed');
  Object.assign(recovered,{status:'scheduled',scheduled_at:'2026-10-04T10:00:00Z'});
  expect(filterActivity(activityItems(state,now),'attention')).toHaveLength(0);
  expect(filterActivity(activityItems(state,new Date('2026-10-04T10:20:00Z')),'attention')).toHaveLength(0);
  expect(filterActivity(activityItems(state,new Date('2026-10-04T10:31:00Z')),'attention')[0].status).toBe('overdue');
  recovered.status='deleted';
  expect(filterActivity(activityItems(state,now),'attention')).toHaveLength(0);
});

test('overdue and missed schedule status is visible without a worker update',async({page})=> {
  const remote=demoState();
  remote.schedules=[{id:'sat',name:'Saturday photo',type:'image',mode:'publish',enabled:true,
    timezone:'Asia/Jerusalem',time:'10:10',days:[5],starts_at:'2026-10-03T07:06:46Z'}];
  remote.scheduler={last_finished_at:'2026-10-03T05:00:15Z'};
  await page.clock.install({time:new Date('2026-10-03T10:19:00Z')});
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const path=new URL(route.request().url()).pathname;
    const body=path==='/api/login'?{token:'test-session',repository:'kourgeorge/alfred_posts_automation'}:remote;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/');
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio'}).click();
  await expect(page.locator('.upcoming-row').filter({hasText:'Saturday photo'})).toContainText('Overdue');
  await page.getByRole('link',{name:'Schedule',exact:true}).click();
  await expect(page.locator('.schedule-run')).toContainText('Overdue');
  await expect(page.locator('.schedule-info')).toContainText('Last completed check:');
  await page.clock.fastForward(24*3600000);
  await expect(page.locator('.schedule-run')).toContainText('Missed');
  await expect(page.locator('.schedule-run')).toContainText('Open Needs attention');
  remote.schedules[0].last_slot='2026-10-03@10:10';
  remote.schedules[0].last_draft_id=remote.drafts[0].id;
  remote.drafts[0].status='published';
  await page.clock.fastForward(9000);
  await expect(page.locator('.schedule-run .badge')).toHaveText('Published');
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
  await page.getByRole('button',{name:'AI prompts',exact:true}).click();
  await expect(page.getByLabel('Photo prompt')).toHaveValue(defaultPrompts.image);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:`test-results/prompts-${width}.png`,fullPage:true});
  expect(errors).toEqual([]);
});

test('prompt editing, format switching, demo saves and restore default preserve captions',async({page})=> {
  await demo(page);
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'AI prompts',exact:true}).click();
  const custom='Write a short friendly caption. כתוב בעברית <script>not code</script>';
  await page.getByLabel('Photo prompt').fill(custom);
  await page.getByRole('button',{name:'Video',exact:true}).click();
  await expect(page.getByLabel('Video prompt')).toHaveValue(defaultPrompts.video);
  await page.getByLabel('Video prompt').fill('My video instructions');
  await page.getByRole('button',{name:/^Photo/}).click();
  await expect(page.getByLabel('Photo prompt')).toHaveValue(custom);
  await page.getByRole('button',{name:'Save prompt',exact:true}).click();
  await expect(page.locator('#prompt-state')).toHaveText('Saved custom prompt');
  await page.getByRole('button',{name:/^Video/}).click();
  await expect(page.getByLabel('Video prompt')).toHaveValue('My video instructions');
  await page.getByRole('button',{name:'Discard changes',exact:true}).click();
  await expect(page.getByLabel('Video prompt')).toHaveValue(defaultPrompts.video);
  await page.getByRole('button',{name:'Question',exact:true}).click();
  await expect(page.locator('.prompt-panel')).toContainText('every answer choice');
  await page.getByRole('button',{name:'Photo',exact:true}).click();
  await page.getByRole('button',{name:'Restore default',exact:true}).click();
  await expect(page.locator('#prompt-state')).toHaveText('Unsaved changes');
  await page.getByRole('button',{name:'Save prompt',exact:true}).click();
  await expect(page.locator('#prompt-state')).toHaveText('Default prompt');
  await page.getByRole('link',{name:'Create a post',exact:true}).click();
  await page.locator('#draft-select').selectOption('demo-photo');
  await expect(page.locator('#caption')).toHaveValue(demoState().drafts[0].text);
});

test('saved prompts survive login and stale edits cannot replace newer prompts',async({page})=> {
  const remote=demoState();let sent;
  await page.clock.install();
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const req=route.request();const path=new URL(req.url()).pathname;
    let body={secrets:[]};
    if(path==='/api/login')body={token:'test-session',repository:'kourgeorge/alfred_posts_automation'};
    if(path==='/api/state')body=remote;
    if(path==='/api/commands') {
      sent=req.postDataJSON();
      remote.prompts??={};remote.prompt_revisions??={};
      const stale=sent.revision!==(remote.prompt_revisions[sent.type]??0);
      if(!stale){remote.prompts[sent.type]=sent.prompt;remote.prompt_revisions[sent.type]=sent.revision+1;}
      remote.operations.unshift({id:sent.id,status:stale?'failed':'complete',error:stale?'This prompt changed in another session.':null});
      return route.fulfill({status:204,body:''});
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  async function signIn() {
    await page.getByLabel('Password',{exact:true}).fill('test-password');
    await page.getByRole('button',{name:'Open studio'}).click();
    await page.getByRole('link',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'AI prompts',exact:true}).click();
  }
  await page.goto('/');await signIn();
  await page.getByLabel('Photo prompt').fill('Persisted instructions');
  await page.getByRole('button',{name:'Save prompt',exact:true}).click();
  await expect(page.locator('#prompt-state')).toHaveText('Saved custom prompt');
  expect(sent).toMatchObject({action:'save_prompt',type:'image',prompt:'Persisted instructions',revision:0});
  await page.reload();await signIn();
  await expect(page.getByLabel('Photo prompt')).toHaveValue('Persisted instructions');
  await page.getByLabel('Photo prompt').fill('Unsaved local edit');
  remote.prompts.image='Updated elsewhere';remote.prompt_revisions.image=2;
  await page.clock.fastForward(9000);
  await expect(page.getByLabel('Photo prompt')).toHaveValue('Unsaved local edit');
  await page.getByRole('button',{name:'Save prompt',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('another session');
  expect(sent.revision).toBe(1);
  expect(remote.prompts.image).toBe('Updated elsewhere');
  await expect(page.getByLabel('Photo prompt')).toHaveValue('Unsaved local edit');
  await page.getByRole('button',{name:'Discard changes',exact:true}).click();
  await expect(page.getByLabel('Photo prompt')).toHaveValue('Updated elsewhere');
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
