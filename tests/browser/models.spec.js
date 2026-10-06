import {test, expect} from '@playwright/test';
import {demoState, demoCommand} from '../../web/demo.js';
import {translations} from '../../web/translations.js';
import {languages} from '../../web/i18n.js';

test.use({locale:'en-US'});
const label=(language,key)=>language==='en'?key:translations[key][language==='he'?0:1];

for(const [language,width] of [['en',1440],['he',390],['ar',320]])test(`model picker and news prompt stages in ${language}`,async({page},testInfo)=> {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width,height:1000});
  await page.goto('/#create');
  await page.getByRole('button',{name:'Explore the demo',exact:true}).click();
  await page.locator('main [data-action="new"]').click();
  await page.getByRole('button',{name:'News Post',exact:true}).click();
  await page.getByRole('button',{name:'Edit news prompts',exact:true}).click();
  await expect(page.getByLabel('News selection prompt')).toHaveValue(/careful news editor/);
  await page.getByLabel('News selection prompt').fill('Prefer local public transport stories.');
  await page.getByRole('button',{name:'Write caption',exact:true}).click();
  await page.getByLabel('News prompt',{exact:true}).fill('Write a concise caption in Hebrew.');
  await page.getByRole('button',{name:'Save prompt',exact:true}).click();
  await expect(page.locator('#prompt-state')).toHaveText('Saved custom prompt');
  await expect(page.locator('#prompt-preview')).toBeDisabled();
  await page.getByRole('button',{name:/^Select news/}).click();
  await expect(page.getByLabel('News selection prompt')).toHaveValue('Prefer local public transport stories.');
  if(language!=='en') {
    await page.locator('[data-language]').click();
    await page.getByRole('menuitemradio',{name:languages[language],exact:true}).click();
  }
  await expect(page.locator('#prompt-text')).toHaveValue('Prefer local public transport stories.');
  await page.getByRole('button',{name:label(language,'Save prompt'),exact:true}).click();
  await expect(page.locator('#prompt-state')).toHaveText(label(language,'Saved custom prompt'));
  await expect(page.locator('#prompt-preview')).toHaveAttribute('data-type','news');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath(`news-prompts-${language}.png`),fullPage:true});
  await page.getByRole('button',{name:label(language,'AI model'),exact:true}).click();
  await page.getByRole('button',{name:label(language,'Refresh models'),exact:true}).click();
  await expect(page.locator('#ai-model option[value="gpt-5-mini"]')).toHaveCount(1);
  await page.locator('#ai-model').selectOption('gpt-5-mini');
  await page.getByRole('button',{name:label(language,'Save model'),exact:true}).click();
  await expect(page.locator('#toast')).toContainText(label(language,'Model saved for all future posts'));
  await expect(page.locator('#ai-model')).toHaveValue('gpt-5-mini');
  await expect(page.getByRole('button',{name:label(language,'Save model'),exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath(`model-${language}.png`),fullPage:true});
  await page.getByRole('button',{name:label(language,'AI prompts'),exact:true}).click();
  await page.locator('#prompt-preview').click();
  await expect(page.getByRole('heading',{name:label(language,'Find a story worth sharing')})).toBeVisible();
  expect(errors).toEqual([]);
});

test('fresh models, persisted saves, stale edits and provider failures',async({page})=> {
  const remote=demoState();
  remote.connection_settings.values.OPENAI_MODEL_VIDEO='different-video-model';
  let fail=false, finish;
  const commands=[];
  await page.clock.install();
  await page.route('https://alfred-studio-gateway.gkour.chatgpt.site/**',async route=> {
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/commands') {
      const command=route.request().postDataJSON();commands.push(command);
      if(fail) {
        await new Promise(resolve=>finish=resolve);
        remote.operations.unshift({id:command.id,status:'failed',error:'OpenAI model request failed. Check your API key, model access and billing, then try again.'});
      } else {
        try {demoCommand(remote,command);}
        catch(error) {remote.operations.unshift({id:command.id,status:'failed',error:error.message});}
        if(command.action==='refresh_models')remote.model_catalog.ids.push('gpt-6-new-model');
      }
      return route.fulfill({status:204,body:''});
    }
    await route.fulfill({json:path==='/api/login'?{token:'session',repository:'kourgeorge/alfred_posts_automation'}:path==='/api/secrets'?{secrets:[]}:remote});
  });
  async function login() {
    await page.getByLabel('Password',{exact:true}).fill('password');
    await page.getByRole('button',{name:'Open studio',exact:true}).click();
    await page.getByRole('button',{name:'AI model',exact:true}).click();
  }
  await page.goto('/#settings');await login();
  await expect(page.locator('.model-panel')).toContainText('different-video-model');
  await page.getByRole('button',{name:'Refresh models',exact:true}).click();
  await expect(page.locator('#ai-model option[value="gpt-6-new-model"]')).toHaveCount(1);
  await page.locator('#ai-model').selectOption('gpt-6-new-model');
  await page.getByRole('button',{name:'Save model',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('Model saved');
  expect(commands[1]).toMatchObject({action:'save_model',model:'gpt-6-new-model',revision:0});
  await page.reload();await login();
  await expect(page.locator('#ai-model')).toHaveValue('gpt-6-new-model');
  await page.locator('#ai-model').selectOption('gpt-5-mini');
  remote.ai_settings={model:'gpt-4.1-mini',revision:2};
  await page.clock.fastForward(9000);
  await expect(page.locator('#ai-model')).toHaveValue('gpt-5-mini');
  await page.getByRole('button',{name:'Save model',exact:true}).click();
  await expect(page.locator('#toast')).toContainText('another session');
  expect(commands.at(-1).revision).toBe(1);
  await page.getByRole('button',{name:'Discard changes',exact:true}).click();
  await expect(page.locator('#ai-model')).toHaveValue('gpt-4.1-mini');
  await page.locator('#ai-model').selectOption('gpt-5-mini');
  fail=true;
  await page.getByRole('button',{name:'Save model',exact:true}).click();
  await expect(page.locator('#ai-model')).toBeDisabled();
  await expect(page.getByRole('button',{name:'Refresh models',exact:true})).toBeDisabled();
  await expect.poll(()=>Boolean(finish)).toBeTruthy();finish();
  await expect(page.locator('#toast')).toContainText('OpenAI model request failed');
  await expect(page.locator('#ai-model')).toHaveValue('gpt-5-mini');
  expect(remote.ai_settings.model).toBe('gpt-4.1-mini');
});
