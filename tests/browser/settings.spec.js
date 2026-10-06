import { test, expect } from '@playwright/test';
import sodium from 'libsodium-wrappers';
import { demoState } from '../../web/demo.js';

async function openSettings(page) {
  await page.goto('/#settings');
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio'}).click();
  await expect(page.getByLabel('Facebook page ID',{exact:true})).toBeVisible();
}

for (const width of [1440,390]) test(`saved settings and replacement visibility work at ${width}px`,async({page})=> {
  await sodium.ready;
  const pair=sodium.crypto_box_keypair();
  const remote=demoState();
  remote.connection_settings.values.OPENAI_MODEL_VIDEO='different-video-model';
  const saved={};const commands=[];
  await page.setViewportSize({width,height:950});
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const request=route.request();const path=new URL(request.url()).pathname;
    let body={};
    if(path==='/api/login')body={token:'test-session',repository:'kourgeorge/alfred_posts_automation'};
    if(path==='/api/state')body=remote;
    if(path==='/api/secrets')body={secrets:[{name:'OPENAI_API_KEY'},{name:'FB_PAGE_ACCESS_TOKEN'}]};
    if(path==='/api/secrets/public-key')body={key_id:'test-key',key:sodium.to_base64(pair.publicKey,sodium.base64_variants.ORIGINAL)};
    if(request.method()==='PUT') {
      const encrypted=request.postDataJSON();
      saved[path.split('/').at(-1)]=sodium.crypto_box_seal_open(sodium.from_base64(encrypted.encrypted_value,sodium.base64_variants.ORIGINAL),pair.publicKey,pair.privateKey,'text');
      return route.fulfill({status:204,body:''});
    }
    if(path==='/api/commands') {
      const command=request.postDataJSON();commands.push(command);
      for(const [name,value] of Object.entries(saved)) if(name in remote.connection_settings.values)remote.connection_settings.values[name]=value;
      remote.operations.unshift({id:command.id,action:command.action,status:'complete'});
      return route.fulfill({status:204,body:''});
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await openSettings(page);
  await expect(page.getByLabel('Facebook page ID',{exact:true})).toHaveValue('1234567890');
  await expect(page.getByLabel('Photo folder ID',{exact:true})).toHaveValue('demo-photo-folder');
  await expect(page.getByLabel('Video caption model',{exact:true})).toHaveValue('different-video-model');
  await expect(page.getByLabel('API key',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Page access token',{exact:true})).toHaveValue('');
  await page.getByLabel('API key',{exact:true}).fill('replacement-api-key');
  await expect(page.getByLabel('Tavily API key',{exact:true})).toHaveValue('');
  await page.getByLabel('Tavily API key',{exact:true}).fill('replacement-tavily-key');
  await page.getByRole('button',{name:'Show api key replacement',exact:true}).click();
  await expect(page.getByLabel('API key',{exact:true})).toHaveAttribute('type','text');
  await page.getByRole('button',{name:'Hide api key replacement',exact:true}).click();
  await expect(page.getByLabel('API key',{exact:true})).toHaveAttribute('type','password');
  await page.getByLabel('Page access token',{exact:true}).fill('replacement-page-token');
  await page.getByRole('button',{name:'Show page access token replacement',exact:true}).click();
  await expect(page.getByLabel('Page access token',{exact:true})).toHaveAttribute('type','text');
  await page.getByLabel('Facebook page ID',{exact:true}).fill('987654321');
  await page.getByRole('button',{name:'Save credentials',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('Saved connection settings refreshed');
  await expect(page.locator('.pending-banner')).toHaveCount(0);
  await expect(page.getByLabel('Facebook page ID',{exact:true})).toHaveValue('987654321');
  expect(saved).toEqual({FB_PAGE_ID:'987654321',OPENAI_API_KEY:'replacement-api-key',FB_PAGE_ACCESS_TOKEN:'replacement-page-token',TAVILY_API_KEY:'replacement-tavily-key'});
  expect(commands.map(c=>c.action)).toEqual(['refresh']);
  await expect(page.getByLabel('API key',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Tavily API key',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Page access token',{exact:true})).toHaveAttribute('type','password');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:`test-results/saved-settings-${width}.png`,fullPage:true});
  await page.reload();
  await expect(page.getByLabel('Password',{exact:true})).toBeVisible();
  await expect(page.locator('#settings-form')).toHaveCount(0);
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:'Open studio'}).click();
  await expect(page.getByLabel('Facebook page ID',{exact:true})).toHaveValue('987654321');
});

test('refresh loads older installations and polling preserves in-progress edits',async({page})=> {
  const remote=demoState();delete remote.connection_settings;
  const commands=[];
  await page.clock.install();
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/commands') {
      const command=route.request().postDataJSON();commands.push(command);
      remote.connection_settings=demoState().connection_settings;
      remote.operations.unshift({id:command.id,status:'complete'});
      return route.fulfill({status:204,body:''});
    }
    const body=path==='/api/login'?{token:'test-session',repository:'kourgeorge/alfred_posts_automation'}:path==='/api/secrets'?{secrets:[]}:remote;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await openSettings(page);
  await expect(page.getByLabel('Facebook page ID',{exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'Refresh saved values',exact:true}).click();
  await expect(page.getByLabel('Facebook page ID',{exact:true})).toHaveValue('1234567890');
  await page.getByLabel('Facebook page ID',{exact:true}).fill('111111');
  await page.getByLabel('API key',{exact:true}).fill('unsaved-key');
  remote.connection_settings.values.FB_PAGE_ID='222222';
  remote.connection_settings.values.DRIVE_FOLDER_ID='updated-photo-folder';
  await page.clock.fastForward(9000);
  await expect(page.getByLabel('Facebook page ID',{exact:true})).toHaveValue('111111');
  await expect(page.getByLabel('Photo folder ID',{exact:true})).toHaveValue('updated-photo-folder');
  await expect(page.getByLabel('API key',{exact:true})).toHaveValue('unsaved-key');
  await page.getByRole('button',{name:'Refresh saved values',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('Save or clear your changes');
  expect(commands).toHaveLength(1);
});
