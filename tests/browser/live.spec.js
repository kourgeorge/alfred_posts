import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Opt-in read-only production smoke check. The gh credential remains in memory
// and is only sent to api.github.com. No post, schedule, or secret is modified.
test('live login, private drafts and credential status',async({page})=> {
  test.skip(!process.env.STUDIO_LIVE_CHECK,'Set STUDIO_LIVE_CHECK=1 for the production read-only check.');
  const errors=[];page.on('pageerror',error=>errors.push(error.name));
  const token=execFileSync('gh',['auth','token'],{encoding:'utf8'}).trim();
  await page.goto('https://kourgeorge.github.io/alfred_posts/');
  await expect(page.getByRole('heading',{name:'A space of your own.'})).toBeVisible();
  await page.getByLabel('Access key',{exact:true}).fill(token);
  await page.getByRole('button',{name:'Open studio'}).click();
  await expect(page.getByRole('heading',{name:'Your content, on autopilot.'})).toBeVisible();
  await expect(page.locator('.connection-status')).toContainText('GitHub connected');
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
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
  await page.locator('.sidebar').getByRole('button',{name:'Lock studio',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A space of your own.'})).toBeVisible();
  expect(errors).toEqual([]);
});
