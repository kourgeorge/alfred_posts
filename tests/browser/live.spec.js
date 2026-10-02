import { test, expect } from '@playwright/test';

// Opt-in read-only production check. Supply STUDIO_PASSWORD through the environment.
// No post, schedule, or service secret is modified. STUDIO_PROMPT_SAVE_CHECK also
// saves one prompt with its existing text to verify the full worker round trip.
test('live login, private drafts and credential status',async({page})=> {
  test.skip(!process.env.STUDIO_LIVE_CHECK,'Set STUDIO_LIVE_CHECK=1 for the production read-only check.');
  const errors=[];page.on('pageerror',error=>errors.push(error.name));
  const password=process.env.STUDIO_PASSWORD;
  expect(Boolean(password),'STUDIO_PASSWORD must be configured').toBeTruthy();
  await page.goto('https://kourgeorge.github.io/alfred_posts/');
  await expect(page.getByRole('heading',{name:'A space of your own.'})).toBeVisible();
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Open studio'}).click();
  await expect(page.getByRole('heading',{name:'Your content, on autopilot.'})).toBeVisible();
  await expect(page.locator('.connection-status')).toContainText('Studio connected');
  await page.getByRole('link',{name:'Create a post',exact:true}).click();
  for(const type of ['image','video','question']) {
    await page.locator('#draft-select').selectOption(`first-preview-${type}-20261002`);
    await expect(page.locator('#caption')).not.toHaveValue('');
    await expect(page.locator('#preview-caption')).not.toBeEmpty();
    const controls=await page.locator('.composer-controls').boundingBox();
    const panel=await page.locator('.composer-controls>.panel').first().boundingBox();
    expect(panel.x+panel.width).toBeLessThanOrEqual(controls.x+controls.width+1);
    if(type!=='video') await expect(page.locator('.post-image')).toBeVisible();
    else await expect(page.getByRole('button',{name:'Watch selected video'})).toBeVisible();
    await page.screenshot({path:`test-results/live-${type}.png`,fullPage:true});
  }
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  for(const key of ['OPENAI_API_KEY','FB_PAGE_ACCESS_TOKEN','GOOGLE_SERVICE_ACCOUNT_JSON'])
    await expect(page.locator(`[data-secret="${key}"]`)).toHaveText('Configured');
  await page.getByRole('button',{name:'AI prompts',exact:true}).click();
  for(const type of ['Photo','Video','Question']) {
    await page.getByRole('button',{name:type,exact:true}).click();
    await expect(page.getByLabel(`${type} prompt`)).not.toHaveValue('');
    await expect(page.getByRole('button',{name:'Save prompt',exact:true})).toBeDisabled();
  }
  if(process.env.STUDIO_PROMPT_SAVE_CHECK) {
    test.setTimeout(240000);
    const original=await page.getByLabel('Question prompt').inputValue();
    await page.getByLabel('Question prompt').fill(original+'\n');
    await page.getByRole('button',{name:'Save prompt',exact:true}).click();
    await expect(page.locator('#toast')).toContainText('Prompt saved.',{timeout:180000});
    await page.reload();
    await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Open studio'}).click();
    await page.getByRole('button',{name:'AI prompts',exact:true}).click();
    await page.getByRole('button',{name:'Question',exact:true}).click();
    await expect(page.getByLabel('Question prompt')).toHaveValue(original);
    await expect(page.getByRole('button',{name:'Save prompt',exact:true})).toBeDisabled();
  }
  await page.screenshot({path:'test-results/live-prompts.png',fullPage:true});
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
  await page.locator('.sidebar').getByRole('button',{name:'Lock studio',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A space of your own.'})).toBeVisible();
  expect(errors).toEqual([]);
});
