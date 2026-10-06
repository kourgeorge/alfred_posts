import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { demoState, demoCommand } from '../../web/demo.js';

const photo = readFileSync(new URL('./fixtures/upload-photo.png',import.meta.url));
const video = readFileSync(new URL('./fixtures/upload-video.mp4',import.meta.url));
const uploadId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function openStudio(page) {
  await page.goto('/#create');
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio',exact:true}).click();
}

for(const width of [1440,390]) test(`upload a photo, describe it and review a draft at ${width}px`,async({page})=> {
  await page.setViewportSize({width,height:1000});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/#create');
  await page.getByRole('button',{name:'Explore the demo'}).click();
  if(width<650)await page.getByRole('button',{name:'Toggle navigation'}).click();
  await page.getByRole('link',{name:'Create a post',exact:true}).click();
  await page.getByRole('button',{name:'Upload image or video',exact:true}).click();
  const generate=page.getByRole('button',{name:'Generate caption',exact:true});
  await expect(generate).toBeDisabled();
  await page.getByLabel('Choose an image or video',{exact:true}).setInputFiles({name:'parking.png',mimeType:'image/png',buffer:photo});
  await expect(page.getByAltText('Selected upload preview')).toBeVisible();
  await expect(generate).toBeDisabled();
  const description='מתרגלים חניה במקביל <script>not code</script>';
  await page.getByLabel('Describe your image or video',{exact:true}).fill(description);
  await page.getByRole('button',{name:'Existing resources',exact:true}).click();
  await expect(page.getByRole('button',{name:'Generate photo draft'})).toBeVisible();
  await page.getByRole('button',{name:'Upload image or video',exact:true}).click();
  await expect(page.getByLabel('Describe your image or video',{exact:true})).toHaveValue(description);
  await generate.click();
  await expect(page.locator('#caption')).toContainText(description);
  await expect(page.locator('.facebook-card .post-image')).toBeVisible();
  await expect(page.locator('.caption-panel .badge')).toHaveText('Draft');
  expect(await page.locator('#media-upload').evaluate(input=>input.files[0].name)).toBe('parking.png');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:`test-results/upload-${width}.png`,fullPage:true});
  await page.locator('#caption').fill('My reviewed upload caption');
  await page.getByRole('button',{name:'Schedule post',exact:true}).click();
  await page.locator('#post-date').fill('2099-10-02T10:30');
  await page.getByRole('dialog').getByRole('button',{name:'Schedule post'}).click();
  await expect(page.locator('.caption-panel .badge')).toHaveText('Scheduled');
  await expect(page.locator('#preview-caption')).toHaveText('My reviewed upload caption');
  expect(errors).toEqual([]);
});

test('uploading a video selects its format and keeps the original available in the draft preview',async({page})=> {
  await page.goto('/');
  await page.getByRole('button',{name:'Explore the demo'}).click();
  await page.getByRole('link',{name:'Create a post',exact:true}).click();
  await page.getByRole('button',{name:'Upload image or video',exact:true}).click();
  await page.getByLabel('Choose an image or video',{exact:true}).setInputFiles({name:'lesson.mp4',mimeType:'video/mp4',buffer:video});
  await expect(page.locator('.upload-selection')).toContainText('Video');
  await page.getByLabel('Describe your image or video',{exact:true}).fill('A lesson on smooth braking');
  await page.getByRole('button',{name:'Generate caption',exact:true}).click();
  await expect(page.locator('#caption')).toContainText('A lesson on smooth braking');
  await page.getByRole('button',{name:'Watch selected video',exact:true}).click();
  await expect.poll(()=>page.locator('.uploaded-player').evaluate(el=>el.readyState)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a failed chunk upload retries with the same file and dispatches only its reference and description',async({page})=> {
  const remote=demoState();const requests=[];const parts=new Map();let fail=true;let manifest;
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const req=route.request();const path=new URL(req.url()).pathname;const value=req.postDataJSON();
    requests.push({path,value,auth:req.headers().authorization});
    let body=remote;
    if(path==='/api/login')body={token:'test-session',repository:'kourgeorge/alfred_posts_automation'};
    if(path.includes('/parts/')) {
      if(path.endsWith('/1')&&fail){fail=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary upload issue. Try again.'})});}
      parts.set(path,value.content);body={size:Buffer.from(value.content,'base64').length};
    } else if(path.startsWith('/api/uploads/')) {manifest=value;body=value;}
    if(path==='/api/commands') {
      if(value.action==='generate_upload') {
        remote.drafts.unshift({id:value.id,type:value.type,status:'draft',revision:1,created_at:new Date().toISOString(),text:'Caption from the supplied description',preview:null,
          source:{...manifest,key:`upload:${value.upload_id}`,upload_id:value.upload_id,description:value.description}});
        remote.operations.unshift({id:value.id,status:'complete',result:value.id});
      } else demoCommand(remote,value);
      return route.fulfill({status:204,body:''});
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await openStudio(page);
  await page.getByRole('button',{name:'Upload image or video',exact:true}).click();
  const bytes=Buffer.concat([photo,Buffer.alloc(2*1024*1024,0)]);
  await page.getByLabel('Choose an image or video',{exact:true}).setInputFiles({name:'parking.png',mimeType:'image/png',buffer:bytes});
  await page.getByLabel('Describe your image or video',{exact:true}).fill('Parking with a beginner');
  await page.getByLabel('Caption style',{exact:true}).selectOption('funny');
  await page.getByRole('button',{name:'Generate caption',exact:true}).click();
  await expect(page.locator('#upload-error')).toContainText('Temporary upload issue');
  await expect(page.getByLabel('Caption style',{exact:true})).toHaveValue('funny');
  expect(requests.filter(r=>r.path==='/api/commands')).toHaveLength(0);
  await page.getByRole('button',{name:'Generate caption',exact:true}).click();
  await expect(page.locator('#caption')).toHaveValue('Caption from the supplied description');
  const sent=requests.find(r=>r.path==='/api/commands').value;
  expect(Object.keys(sent).sort()).toEqual(['action','caption_style','description','id','type','upload_id']);
  expect(sent).toMatchObject({action:'generate_upload',type:'image',description:'Parking with a beginner',caption_style:'funny'});
  expect(requests.filter(r=>r.path.endsWith('/parts/0')).map(r=>r.path)).toEqual([`/api/uploads/${sent.upload_id}/parts/0`,`/api/uploads/${sent.upload_id}/parts/0`]);
  expect(manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(Buffer.concat([...parts.values()].map(content=>Buffer.from(content,'base64')))).toEqual(bytes);
  expect(requests.filter(r=>r.path!=='/api/login').every(r=>r.auth==='Bearer test-session')).toBeTruthy();
  await page.locator('#caption').fill('Reviewed text');
  await page.getByRole('button',{name:'Schedule post',exact:true}).click();
  await page.locator('#post-date').fill('2099-10-02T10:30');
  await page.getByRole('dialog').getByRole('button',{name:'Schedule post'}).click();
  await expect(page.locator('.caption-panel .badge')).toHaveText('Scheduled');
  expect(remote.drafts[0].source.upload_id).toBe(sent.upload_id);
});

test('saved uploaded video plays through authenticated storage after a fresh login',async({page})=> {
  const remote=demoState();const reads=[];
  remote.drafts.unshift({id:'uploaded-video',type:'video',status:'draft',revision:1,text:'Parking lesson',created_at:new Date().toISOString(),
    source:{key:`upload:${uploadId}`,upload_id:uploadId,name:'parking.mp4',mime:'video/mp4',size:video.length,parts:1,sha256:createHash('sha256').update(video).digest('hex')}});
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=>{
    const req=route.request();const path=new URL(req.url()).pathname;
    let body=path==='/api/login'?{token:'test-session',repository:'kourgeorge/alfred_posts_automation'}:remote;
    if(path.includes('/parts/')) {reads.push(req.headers().authorization);body={content:video.toString('base64'),size:video.length};}
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await openStudio(page);
  await page.locator('#draft-select').selectOption('uploaded-video');
  await page.getByRole('button',{name:'Watch selected video',exact:true}).click();
  const player=page.locator('video.uploaded-player');
  await expect(player).toBeVisible();
  await expect.poll(()=>player.evaluate(el=>el.readyState)).toBeGreaterThan(0);
  expect(reads).toEqual(['Bearer test-session']);
  const url=await player.getAttribute('src');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.locator('.sidebar').getByRole('button',{name:'Lock studio',exact:true}).click();
  expect(await page.evaluate(async url=>{try{await fetch(url);return true;}catch{return false;}},url)).toBeFalsy();
});

test('unsupported uploads are rejected and locking cancels a transfer before generation',async({page})=>{
  const remote=demoState();let release;let dispatched=false;
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.includes('/parts/'))await new Promise(resolve=>release=resolve);
    if(path==='/api/commands')dispatched=true;
    const body=path==='/api/login'?{token:'test-session',repository:'kourgeorge/alfred_posts_automation'}:remote;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
  });
  await openStudio(page);
  await page.getByRole('button',{name:'Upload image or video',exact:true}).click();
  await page.getByLabel('Choose an image or video',{exact:true}).setInputFiles({name:'unsafe.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
  await expect(page.locator('#upload-error')).toContainText('Choose a JPG');
  await page.getByLabel('Choose an image or video',{exact:true}).setInputFiles({name:'parking.png',mimeType:'image/png',buffer:photo});
  await page.getByLabel('Describe your image or video',{exact:true}).fill('Private description');
  await page.getByRole('button',{name:'Generate caption',exact:true}).click();
  await expect(page.locator('#upload-progress')).toBeVisible();
  await expect.poll(()=>Boolean(release)).toBeTruthy();
  await page.locator('.sidebar').getByRole('button',{name:'Lock studio',exact:true}).click();
  release();
  await expect(page.getByRole('heading',{name:'A space of your own.'})).toBeVisible();
  expect(dispatched).toBeFalsy();
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio',exact:true}).click();
  await page.getByRole('button',{name:'Upload image or video',exact:true}).click();
  await expect(page.getByLabel('Describe your image or video',{exact:true})).toHaveValue('');
  await expect(page.getByAltText('Selected upload preview')).toHaveCount(0);
});
