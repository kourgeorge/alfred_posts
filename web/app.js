import './style.css';
import { icon } from './icons.js';
import defaultPrompts from '../prompts.json';
import * as github from './api.js';
import { demoState, demoCommand } from './demo.js';
import { escape as e, dayNames, typeNames, editable, formatDate, nextOccurrence, scheduleRun, dueTasks, inZone, zonedParts, sourceUrl } from './utils.js';

const root = document.querySelector('#app');
let config = {gateway: ''};
let state = {drafts: [], schedules: [], operations: []};
let demo = false;
let signedIn = false;
let selectedType = 'image';
let selectedDraft = null;
let pending = null;
let secretNames = new Set();
let secretsLoaded = false;
let secretsError = '';
let activityFilter = 'all';
let mobileNav = false;
let polling = false;
let toastTimer;
let renderedState = '';
const edits = new Map();
const editRevisions = new Map();
let editorSnapshot = null;
let settingsView = 'connections';
let promptType = 'image';
let promptSnapshot = null;
const promptEdits = new Map();
const route = () => ['overview','create','schedule','activity','settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
const currentDraft = () => state.drafts.find(d => d.id === selectedDraft);
const draftText = draft => edits.get(draft.id) ?? draft.text;
const blocked = () => pending ? 'disabled' : '';
const badge = (status) => `<span class="badge ${e(status)}"><i></i>${e({draft:'Draft',scheduled:'Scheduled',preparing:'Preparing',publishing:'Publishing',processing:'Processing',published:'Published',failed:'Needs attention',uncertain:'Check Facebook',deleted:'Deleted',running:'In progress',complete:'Complete',waiting:'Waiting for worker',overdue:'Overdue',missed:'Missed'}[status] || status)}</span>`;
const typeIcon = (type) => `<span class="type-icon ${e(type)}">${icon(type)}</span>`;
const brand = () => `<div class="brand"><span class="brand-symbol">${icon('leaf')}</span><span>alfred<span class="brand-dot">.</span></span></div>`;

function toast(message, error = false) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.className = `visible ${error ? 'error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = '', 6500);
}

function login(error = '') {
  root.innerHTML = `<div class="login-layout">
    <section class="login-story">${brand()}<div class="login-copy"><span class="eyebrow">YOUR OWN LITTLE PUBLISHING STUDIO</span><h1>Good content.<br>A little more<br><em>consistently.</em></h1><p>Turn your ideas into a steady rhythm of posts.<br>Plan, preview, and publish. All in one place.</p><div class="login-types"><span>${icon('image')}Photos</span><span>${icon('video')}Videos</span><span>${icon('question')}Questions</span></div></div><div class="login-footer">Made for Alfred Kor <span>Powered by GitHub ${icon('github')}</span></div><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div></section>
    <section class="login-panel"><div class="login-form-wrap"><span class="lock-tile">${icon('lock')}</span><span class="eyebrow">ALFRED STUDIO</span><h2>A space of your own.</h2><p>Enter your password to open your studio.</p>
      <form id="login-form"><label for="studio-password">Password</label><input id="studio-password" name="password" type="password" placeholder="Your studio password" required autocomplete="current-password" spellcheck="false" autofocus />
      <div id="login-error" class="form-error" role="alert">${e(error)}</div><button class="btn primary login-submit" type="submit">Open studio ${icon('arrow')}</button></form>
      <div class="login-note">${icon('lock')}<span>One password. Your own private workspace.<br>Close or refresh this tab to lock the studio.</span></div><div class="login-divider"><span>just looking around?</span></div><button class="btn demo-btn" data-action="demo">Explore the demo ${icon('arrow')}</button><small class="muted demo-caption">Sample content. No real posts or API calls.</small>
    </div></section></div>`;
}

function shell() {
  const page = route();
  const labels = {overview:'Overview',create:'Create a post',schedule:'Schedule',activity:'Activity',settings:'Settings'};
  const nav = [['overview','grid'],['create','plus'],['schedule','calendar'],['activity','activity']];
  root.innerHTML = `<div class="app-layout ${mobileNav ? 'nav-open' : ''}">
    <aside class="sidebar">${brand()}<div class="workspace-card"><div class="avatar">AK</div><div><strong>Alfred Kor</strong><span><b class="facebook-mini">f</b> Facebook page</span></div>${icon('chevron')}</div>
    <span class="nav-label">WORKSPACE</span><nav aria-label="Main navigation">${nav.map(([id,ico]) => `<a href="#${id}" class="nav-link ${page===id?'active':''}" ${page===id?'aria-current="page"':''}>${icon(ico)}${labels[id]}${id==='create'?'<span class="nav-shortcut" aria-hidden="true">+</span>':''}</a>`).join('')}</nav>
    <div class="sidebar-bottom"><div class="sidebar-note">${icon('leaf')}<strong>A good rhythm goes a long way.</strong><p>Keep your page active.<br>Keep your time for you.</p></div><a href="#settings" class="nav-link ${page==='settings'?'active':''}">${icon('settings')}Settings</a><button class="nav-link" data-action="logout">${icon('logout')}${demo?'Exit demo':'Lock studio'}</button><div class="connection-status"><i></i>${demo?'Demo workspace':'Studio connected'}${icon('github')}</div></div></aside>
    <div class="workspace"><header class="topbar"><div class="breadcrumb"><button class="icon-btn mobile-menu" data-action="menu" aria-label="Toggle navigation">${icon('menu')}</button><span>Workspace</span>${icon('chevron')}<strong>${labels[page]}</strong></div><div class="topbar-end"><span class="timezone">${icon('globe')} Asia/Jerusalem</span><span class="session-pill">${icon(demo?'info':'lock')}${demo?'Demo mode':'Private studio'}</span><div class="small-avatar">AK</div></div></header>
    ${demo?'<div class="demo-banner"><span><strong>A look around your future studio.</strong> You’re using sample content.</span><button data-action="logout">Open your studio '+icon('arrow')+'</button></div>':''}
    <main id="main-content">${pending?`<div class="pending-banner" role="status"><span class="spinner"></span><div><strong>${e(pending.label)}</strong><span>${Date.now()-pending.started>180000?'Still waiting for GitHub. You can check progress in Actions.':'GitHub is working on your request. This usually takes a minute.'}</span></div>${demo?'':`<a href="https://github.com/${e(github.repoName())}/actions/workflows/studio.yml" target="_blank" rel="noopener noreferrer">View progress ${icon('external')}</a>`}</div>`:''}
    ${{overview:overview,create:composer,schedule:schedulePage,activity:activityPage,settings:settingsPage}[page]()}</main>
    <footer class="workspace-footer"><span>Alfred Studio <span class="footer-dot">·</span> A little more consistent.</span><span>${icon('clock')} Times shown in Israel time unless specified</span></footer></div></div>`;
}

function heading(kicker,title,description,action='') {
  return `<div class="page-heading"><div><span class="eyebrow">${kicker}</span><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}

function overview() {
  const drafts = state.drafts.filter(d => ['draft','failed'].includes(d.status));
  const published = state.drafts.filter(d => d.status === 'published');
  const scheduled = state.schedules.filter(s => s.enabled);
  const today = new Intl.DateTimeFormat('en',{weekday:'long',month:'long',day:'numeric',timeZone:'Asia/Jerusalem'}).format(new Date());
  return `${heading(e(today.toUpperCase()),'Your content, on autopilot.','A clear head. A full content calendar. A little time back.',`<button class="btn primary" data-action="new">${icon('plus')} Create a post</button>`)}
    <section class="stats-grid" aria-label="Workspace totals">${[[published.length,'Posts published','send','Your ideas, out in the world'],[drafts.length,'Drafts to review','edit','A fresh perspective is waiting'],[scheduled.length,'Active schedules','calendar','A rhythm that works for you']].map(([n,label,ico,note])=>`<div class="stat-card"><div><span class="stat-label">${label}</span><strong>${n.toString().padStart(2,'0')}</strong><small>${note}</small></div><span class="stat-icon">${icon(ico)}</span></div>`).join('')}</section>
    <div class="overview-grid"><section class="panel creation-panel"><div class="section-title"><div><span class="eyebrow">LET’S MAKE SOMETHING</span><h2>What will you share today?</h2></div>${icon('spark')}</div><p>A useful tip, a lesson, or a question that starts a conversation.</p><div class="create-type-grid">${Object.keys(typeNames).map(type=>`<button class="create-type ${type}" data-action="new" data-type="${type}">${typeIcon(type)}<strong>${typeNames[type]}</strong><span>${{image:'Let an image do the talking',video:'Bring a lesson to life',question:'Get people thinking'}[type]}</span>${icon('arrow')}</button>`).join('')}</div><div class="soft-note">${icon('check')} Every new post starts with a draft you can review.</div></section>
    <section class="panel next-panel"><div class="section-title"><h2>Coming up next</h2><a href="#schedule" class="text-link">View all ${icon('arrow')}</a></div>${upcomingRows()}<div class="cadence-note">${icon('clock')} Checks are requested every 30 minutes. Delayed posts can catch up within 24 hours.</div></section></div>
    <section class="panel drafts-panel"><div class="section-title"><div><h2>On your desk <span class="count-chip">${drafts.length}</span></h2><p>A few words away from ready.</p></div><a class="text-link" href="#create">Open drafts ${icon('arrow')}</a></div>${drafts.length?drafts.slice(0,3).map(d=>draftRow(d)).join(''):empty('edit','Room for your next idea','Create a photo, video, or question post to get started.')}</section>`;
}

function upcomingRows() {
  const items = [
    ...state.schedules.filter(s=>s.enabled).map(s=>{
      const run=scheduleRun(s,state.drafts);
      const pendingRun=run&&['waiting','overdue','missed'].includes(run.status);
      return {name:s.name,type:s.type,date:pendingRun?run.date:nextOccurrence(s),mode:s.mode,status:pendingRun?run.status:null};
    }),
    ...state.drafts.filter(d=>d.status==='scheduled').map(d=>({name:d.source.name,type:d.type,date:new Date(d.scheduled_at),mode:'publish'})),
  ].filter(x=>x.date).sort((a,b)=>a.date-b.date).slice(0,3);
  return items.length ? items.map(item=>`<div class="upcoming-row">${typeIcon(item.type)}<div><strong>${e(item.name)}</strong><span>${e(formatDate(item.date))} <b>·</b> ${item.status?e({waiting:'Waiting for worker',overdue:'Overdue · waiting for worker',missed:'Missed · needs attention'}[item.status]):item.mode==='draft'?'Prepare draft':'Auto-publish'}</span></div>${icon('chevron')}</div>`).join('') : empty('calendar','Find your rhythm','Add a recurring schedule or choose a time for a finished draft.');
}

function draftRow(draft) {
  return `<button class="draft-row" data-action="open-draft" data-id="${e(draft.id)}">${typeIcon(draft.type)}<div class="draft-row-main"><strong>${e(draft.source.name)}</strong><span>${e(typeNames[draft.type])} <b>·</b> ${e(formatDate(draft.created_at))}</span></div>${badge(draft.status)}<span class="draft-open">Review ${icon('arrow')}</span></button>`;
}

function empty(ico,title,description) { return `<div class="empty-state">${icon(ico)}<strong>${title}</strong><p>${description}</p></div>`; }

function composer() {
  const draft = currentDraft();
  editorSnapshot = draft ? {id: draft.id, revision: editRevisions.get(draft.id) ?? draft.revision, text: draftText(draft)} : null;
  const available = state.drafts.filter(d=>['draft','scheduled','failed'].includes(d.status));
  const canEdit = editable(draft);
  return `${heading('CREATE & PREVIEW','Good ideas, ready to share.','Pick a format, make it yours, and see exactly what goes out.')}
    <div class="composer-layout"><section class="composer-controls"><div class="panel"><div class="step-title"><span>01</span><h2>Choose your format</h2></div><div class="format-picker">${Object.keys(typeNames).map(type=>`<button class="format-option ${selectedType===type?'selected':''}" data-action="type" data-type="${type}" aria-pressed="${selectedType===type}">${icon(type)}${typeNames[type]}${selectedType===type?'<span class="selected-dot"></span>':''}</button>`).join('')}</div><p class="field-hint">${{image:'A photo from your Drive folder, with a fresh Hebrew caption.',video:'A video from your Drive folder, with a caption to match.',question:'A question and its image from Google Forms, with the original answers.'}[selectedType]}</p><button class="btn primary generate-btn" data-action="generate" ${blocked()}>${icon('spark')} Generate ${typeNames[selectedType].toLowerCase()} draft</button><div class="micro-note">Creates a preview. You decide when to publish.</div></div>
    <div class="panel caption-panel"><div class="step-title"><span>02</span><h2>Make it yours</h2>${draft?badge(draft.status):''}</div>
    ${available.length?`<label for="draft-select">Open a saved draft</label><select id="draft-select"><option value="">Choose a draft…</option>${available.map(d=>`<option value="${e(d.id)}" ${d.id===selectedDraft?'selected':''}>${e(typeNames[d.type])} · ${e(d.source.name)}</option>`).join('')}</select>`:''}
    ${draft?`<div class="source-label">${icon(draft.type)}<span>${e(draft.source.name)}</span>${sourceUrl(draft.source.url)?`<a href="${e(sourceUrl(draft.source.url))}" target="_blank" rel="noopener noreferrer" aria-label="Open original media">${icon('external')}</a>`:''}</div><label for="caption">Post caption <span>Hebrew supported</span></label><textarea id="caption" dir="auto" maxlength="12000" ${canEdit&&!pending?'':'readonly'}>${e(draftText(draft))}</textarea><div class="caption-meta"><span id="caption-count">${draftText(draft).length.toLocaleString()} characters</span><span id="edit-state">${edits.has(draft.id)?'Unsaved changes':'Saved draft'}</span></div>
    ${draft.error?`<div class="form-error">${e(draft.error)}</div>`:''}${draft.status==='scheduled'?`<div class="inline-note">${icon('calendar')} Scheduled for ${e(formatDate(draft.scheduled_at))}</div>`:''}
    ${canEdit?`<div class="editor-actions"><button class="text-link" data-action="revert-edits" ${blocked()}>Revert edits</button><button class="btn secondary" data-action="save-draft" ${blocked()}>${icon('check')} Save draft</button><button class="icon-btn danger" data-action="delete-draft" aria-label="Delete draft" ${blocked()}>${icon('trash')}</button></div>`:''}`:empty('edit','A fresh draft starts here','Generate a post or open a saved draft to edit the caption.')}</div>
    ${draft&&canEdit?`<div class="publish-actions"><button class="btn secondary" data-action="schedule-draft" ${blocked()}>${icon('calendar')} ${draft.status==='scheduled'?'Change time':'Schedule post'}</button><button class="btn primary" data-action="publish" ${blocked()}>${icon('send')} Publish now</button></div>${draft.status==='scheduled'?`<button class="text-link cancel-schedule" data-action="cancel-draft" ${blocked()}>Move back to drafts</button>`:''}`:''}</section>
    <section class="preview-column"><div class="preview-heading"><span class="eyebrow">LIVE PREVIEW</span><span><b class="facebook-mini">f</b> Facebook</span></div><article class="facebook-card"><div class="facebook-header"><div class="avatar">AK</div><div><strong>מורה נהיגה - אלפרד קור</strong><span>${demo?'Demo preview':'Post preview'} · ${icon('globe')}</span></div><span class="facebook-more">···</span></div><div id="preview-caption" class="preview-caption" dir="auto">${draft?e(draftText(draft)):'Your next post starts with an idea.\nGenerate a draft to see it here.'}</div>${mediaPreview(draft)}<div class="facebook-reactions"><span>♡</span><span>Like</span><span>Comment</span><span>Share</span></div></article><p class="preview-note">${icon('info')} A close preview of your post. Facebook may display media and line breaks differently.</p>${draft?.facebook_url?`<a class="btn secondary" href="${e(sourceUrl(draft.facebook_url))}" target="_blank" rel="noopener noreferrer">View on Facebook ${icon('external')}</a>`:''}</section></div>`;
}

function mediaPreview(draft) {
  if (!draft) return `<div class="media-placeholder">${icon('image')}<span>Your media will appear here</span></div>`;
  if (draft.type==='video') return `<div class="video-preview"><div class="video-pattern"></div><span class="video-play">${icon('play')}</span><strong>${e(draft.source.name)}</strong><span>${demo?'Sample video preview':'Your selected Drive video'}</span>${sourceUrl(draft.source.url)?`<button class="btn" data-action="watch-video">Watch selected video ${icon('external')}</button>`:''}</div>`;
  const src = draft.preview;
  if (src && (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(src) || demo&&src==='./road.svg')) return `<img class="post-image" src="${e(src)}" alt="${e(draft.source.name)}" />`;
  return `<div class="media-placeholder">${icon(draft.type)}<span>${e(draft.source.name)}</span>${sourceUrl(draft.source.url)?`<a class="text-link" href="${e(sourceUrl(draft.source.url))}" target="_blank" rel="noopener noreferrer">Open original ${icon('external')}</a>`:''}</div>`;
}

function schedulePage() {
  const queued = state.drafts.filter(d=>d.status==='scheduled');
  return `${heading('YOUR PUBLISHING RHYTHM','A little planning. A lot of freedom.','Set it up once. Keep showing up for your audience.',`<button class="btn primary" data-action="new-schedule" ${blocked()}>${icon('plus')} Add a schedule</button>`)}
    <div class="schedule-info">${icon('clock')}<div><strong>Delayed posts stay on the schedule.</strong><span>Checks are requested every 30 minutes, but GitHub can start them late. The latest recurring post catches up within 24 hours; older missed runs need your attention.</span><span>${state.scheduler?.last_finished_at?`Last completed check: ${e(formatDate(state.scheduler.last_finished_at))}`:'No completed schedule check recorded yet.'}</span></div><button class="btn secondary run-due-trigger" data-action="run-due" ${blocked()}>${icon('send')} Run due tasks now</button></div>
    <section class="panel week-panel"><div class="section-title"><h2>Your weekly rhythm</h2><span class="muted">Recurring schedules</span></div><div class="week-grid">${dayNames.map((day,i)=>`<div class="week-day"><div class="week-day-label">${day}<span>${state.schedules.filter(s=>s.enabled&&s.days.includes(i)).length||'—'}</span></div>${state.schedules.filter(s=>s.enabled&&s.days.includes(i)).map(s=>`<button class="week-event ${e(s.type)}" ${blocked()} data-action="edit-schedule" data-id="${e(s.id)}"><span>${icon(s.type)}${e(s.time)}</span><strong>${e(s.name)}</strong><small>${s.mode==='draft'?'Draft':'Publish'}</small></button>`).join('')}</div>`).join('')}</div></section>
    <section class="schedules-list"><div class="section-title"><h2>Recurring schedules <span class="count-chip">${state.schedules.length}</span></h2></div>${state.schedules.length?state.schedules.map(scheduleCard).join(''):empty('calendar','Make room for consistency','Add your first schedule. You can prepare drafts or publish automatically.')}</section>
    ${queued.length?`<section class="panel"><div class="section-title"><h2>One-time posts</h2><span class="muted">Ready for their moment</span></div>${queued.sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at)).map(d=>`<div class="one-time-row">${draftRow(d)}<span class="muted">${e(formatDate(d.scheduled_at))}</span></div>`).join('')}</section>`:''}`;
}

function scheduleCard(s) {
  const run=scheduleRun(s,state.drafts);
  const message=run?.error || ({waiting:'Waiting for the next worker check.',overdue:'The worker is delayed. This run can still catch up within 24 hours.',missed:'The 24-hour catch-up window ended. Create a post manually if it is still needed.'}[run?.status] || 'Latest run');
  return `<article class="schedule-card ${s.enabled?'':'paused-card'}">${typeIcon(s.type)}<div class="schedule-card-main"><div><h3>${e(s.name)}</h3><span class="badge ${s.enabled?'active':'paused'}"><i></i>${s.enabled?'Active':'Paused'}</span></div><p>${e(s.days.map(d=>dayNames[d]).join(', '))} <b>·</b> ${e(s.time)} <b>·</b> ${e(s.timezone)} <b>·</b> ${s.mode==='draft'?'Prepare a draft':'Publish automatically'}</p>${run?`<div class="schedule-run">${badge(run.status)}<span>${e(formatDate(run.date))} · ${e(message)}</span></div>`:''}</div><div class="schedule-card-actions"><button class="icon-btn" data-action="edit-schedule" data-id="${e(s.id)}" aria-label="Edit ${e(s.name)}" ${blocked()}>${icon('edit')}</button><button class="switch ${s.enabled?'on':''}" role="switch" aria-checked="${s.enabled}" aria-label="Enable ${e(s.name)}" data-action="toggle-schedule" data-id="${e(s.id)}" ${blocked()}><span></span></button></div></article>`;
}

function activityPage() {
  const all = state.drafts.filter(d=>!['draft','deleted'].includes(d.status));
  const filtered = all.filter(d=>activityFilter==='all'||activityFilter==='published'&&d.status==='published'||activityFilter==='attention'&&['failed','uncertain','preparing','publishing','processing'].includes(d.status)||activityFilter==='scheduled'&&d.status==='scheduled');
  const failedOps = state.operations.filter(op=>op.status==='failed');
  return `${heading('THE BIGGER PICTURE','Every post has a story.','See what’s published, what’s on its way, and what needs a little attention.',`<button class="btn secondary" data-action="refresh" ${blocked()}>${icon('refresh')} Refresh status</button>`)}
    <div class="filter-bar" role="group" aria-label="Filter activity">${[['all','All posts'],['published','Published'],['scheduled','Scheduled'],['attention','Needs attention']].map(([value,label])=>`<button data-action="filter" data-filter="${value}" aria-pressed="${activityFilter===value}" class="${activityFilter===value?'selected':''}">${label}</button>`).join('')}</div>
    <section class="panel activity-panel">${filtered.length?filtered.map(d=>`<article class="activity-row">${typeIcon(d.type)}<div class="activity-main"><strong>${e(d.source.name)}</strong><span>${e(typeNames[d.type])} <b>·</b> ${e(formatDate(d.published_at||d.scheduled_at||d.created_at))}</span>${d.error?`<p class="activity-error">${e(d.error)}</p>`:''}</div>${badge(d.status)}${sourceUrl(d.facebook_url)?`<a class="icon-btn" href="${e(sourceUrl(d.facebook_url))}" target="_blank" rel="noopener noreferrer" aria-label="View post on Facebook">${icon('external')}</a>`:`<button class="icon-btn" data-action="open-draft" data-id="${e(d.id)}" aria-label="Open post">${icon('chevron')}</button>`}</article>`).join(''):empty('activity','A clean slate','Your published and scheduled posts will appear here.')}</section>
    ${failedOps.length?`<section class="panel operation-panel"><div class="section-title"><h2>Recent workflow issues</h2>${demo?'':`<a class="text-link" href="https://github.com/${e(github.repoName())}/actions" target="_blank" rel="noopener noreferrer">Open GitHub Actions ${icon('external')}</a>`}</div>${failedOps.slice(0,6).map(op=>`<div class="operation-row"><span class="error-dot"></span><div><strong>${e(op.action.replaceAll('_',' '))}</strong><p>${e(op.error)}</p></div><span class="muted">${e(formatDate(op.created_at))}</span></div>`).join('')}</section>`:''}`;
}

function settingsPage() {
  const prompts = settingsView === 'prompts';
  return `${heading('MAKE YOURSELF AT HOME', prompts?'Your voice, in every post.':'The keys to your studio.', prompts?'Shape the tone, language, and style of each kind of post.':'Update your connections in one place. Saved keys stay private.')}
    <div class="filter-bar settings-views" role="group" aria-label="Settings sections">${[['connections','Connections'],['prompts','AI prompts']].map(([view,label])=>`<button data-action="settings-view" data-view="${view}" aria-pressed="${settingsView===view}" class="${settingsView===view?'selected':''}" ${blocked()}>${label}</button>`).join('')}</div>
    ${prompts?promptsPage():connectionsPage()}`;
}

function promptsPage() {
  const edit=promptEdits.get(promptType);
  const text=edit?.text??state.prompts?.[promptType]??defaultPrompts[promptType];
  promptSnapshot={type:promptType,text,revision:edit?.revision??state.prompt_revisions?.[promptType]??0};
  return `<div class="settings-layout"><form id="prompt-form" class="panel prompt-panel">
    <div class="section-title"><div><h2>Caption instructions</h2><p>A separate prompt for each post format.</p></div>${icon('spark')}</div>
    <div class="format-picker" role="group" aria-label="Prompt format">${Object.entries(typeNames).map(([type,label])=>`<button type="button" class="format-option ${promptType===type?'selected':''}" data-action="prompt-type" data-type="${type}" aria-pressed="${promptType===type}" ${blocked()}>${icon(type)}${label}${promptEdits.has(type)?'<span class="prompt-unsaved" title="Unsaved changes">Edited</span>':''}</button>`).join('')}</div>
    <label for="prompt-text">${e(typeNames[promptType])} prompt</label><textarea id="prompt-text" name="prompt" dir="auto" maxlength="8000" rows="16" required spellcheck="false" ${pending?'readonly':''}>${e(text)}</textarea>
    <div class="caption-meta"><span id="prompt-count">${text.length.toLocaleString()} / 8,000 characters</span><span id="prompt-state" role="status">${edit?'Unsaved changes':text===defaultPrompts[promptType]?'Default prompt':'Saved custom prompt'}</span></div>
    <p class="field-hint">${promptType==='question'?'This prompt controls the introduction. The original question, every answer choice, and course links are added automatically.':'The current date and selected media details are added automatically. Write instructions for the caption you want.'}</p>
    <div class="prompt-tools"><button type="button" class="text-link" data-action="default-prompt" ${blocked()}>${icon('refresh')} Restore default</button><button type="button" class="text-link" data-action="discard-prompt" ${pending||!edit?'disabled':''}>Discard changes</button></div>
    <div class="settings-save prompt-save"><span>${icon('lock')} Saved privately for future posts.</span><button type="submit" class="btn primary" ${pending||!edit||!text.trim()?'disabled':''}>${icon('check')} Save prompt</button></div>
  </form><aside class="settings-aside"><div class="panel security-note"><span class="lock-tile">${icon('spark')}</span><h3>Make it sound like you.</h3><p>Describe your preferred language, tone, caption length, contact details, and call to action.</p><p>Save each format separately. Restoring a default takes effect after you save it.</p></div><div class="panel security-note"><h3>Save. Generate. Preview.</h3><p>New drafts and recurring posts use the latest saved prompt. Existing drafts keep the captions you already reviewed.</p><button id="prompt-preview" type="button" class="btn secondary" data-action="new" data-type="${promptType}" ${pending||edit?'disabled':''}>${icon('edit')} Preview a new post</button><p>${demo?'Demo saves are temporary. Generated demo captions remain sample text.':'A generation already in progress keeps the prompt it started with.'}</p></div></aside></div>`;
}

function connectionsPage() {
  const configured = name => `<span data-secret="${name}" class="secret-state ${secretNames.has(name)||demo?'set':''}">${demo?'Demo':!secretsLoaded?'Not checked':secretNames.has(name)?'Configured':'Not configured'}</span>`;
  return `<div class="settings-layout"><form id="settings-form" class="settings-form"><section class="panel"><div class="section-title"><div class="settings-title"><span class="service-symbol facebook-symbol">f</span><div><h2>Facebook</h2><p>The page you’re sharing with.</p></div></div>${configured('FB_PAGE_ACCESS_TOKEN')}</div><label for="fb-token">Page access token</label><input id="fb-token" type="password" name="FB_PAGE_ACCESS_TOKEN" placeholder="Paste a new page access token" autocomplete="new-password" /><p class="field-hint">Needs pages_manage_posts and pages_read_engagement permission.</p><label for="fb-page">Facebook page ID <span>Optional update</span></label><input id="fb-page" name="FB_PAGE_ID" placeholder="168846083148109" inputmode="numeric" autocomplete="off" /></section>
    <section class="panel"><div class="section-title"><div class="settings-title"><span class="service-symbol openai-symbol">${icon('spark')}</span><div><h2>OpenAI</h2><p>A little help finding the right words.</p></div></div>${configured('OPENAI_API_KEY')}</div><label for="openai-key">API key</label><input id="openai-key" type="password" name="OPENAI_API_KEY" placeholder="Paste a new OpenAI API key" autocomplete="new-password" /><p class="field-hint">Used to generate Hebrew captions. API usage is billed to your OpenAI account.</p><label for="openai-model">Caption model <span>Optional update · all formats</span></label><input id="openai-model" name="MODEL" placeholder="gpt-4.1-mini" autocomplete="off" /></section>
    <section class="panel"><div class="section-title"><div class="settings-title"><span class="service-symbol google-symbol">${icon('image')}</span><div><h2>Google Drive & Forms</h2><p>Your library of photos, videos, and questions.</p></div></div>${configured('GOOGLE_SERVICE_ACCOUNT_JSON')}</div><details><summary>Update content sources ${icon('chevron')}</summary><label for="google-key">Service account JSON</label><textarea id="google-key" name="GOOGLE_SERVICE_ACCOUNT_JSON" class="credential-textarea" placeholder="Paste the new service account JSON" spellcheck="false" autocomplete="off"></textarea><p class="field-hint">Share each media folder and question form with the service account email.</p>${[['DRIVE_FOLDER_ID','Photo folder ID'],['DRIVE_FOLDER_ID_VIDEO','Video folder ID'],['DRIVE_FOLDER_ID_QUESTIONS','Question forms folder ID']].map(([name,label])=>`<label for="${name}">${label}</label><input id="${name}" name="${name}" placeholder="Leave empty to keep the current folder" autocomplete="off" />`).join('')}</details></section>
    <div id="settings-error" class="form-error" role="alert">${e(secretsError)}</div><div class="settings-save"><span>${icon('lock')} Blank fields keep existing values.</span><button type="submit" class="btn primary">${icon('check')} Save credentials</button></div></form>
    <aside class="settings-aside"><div class="panel security-note"><span class="lock-tile">${icon('lock')}</span><h3>Private by design.</h3><p>Credentials are encrypted in your browser and saved in your private repository’s GitHub Secrets.</p><p>They’re never saved in this website or returned to the browser. To change a key, simply enter a replacement.</p><div class="soft-note">${icon('check')} No database. No extra account.</div></div><div class="panel connection-panel"><span class="eyebrow">YOUR CONNECTION</span><h3>${icon('github')} GitHub Actions</h3><p class="repo-name">${e(demo?'Demo workspace':github.repoName())}</p><span class="connection-inline"><i></i>${demo?'Sample data only':'Password session active'}</span><button class="btn secondary" data-action="logout">${icon('lock')} Lock studio</button></div><div class="plain-note">${icon('info')} Saving credentials affects future runs. A workflow already in progress keeps its current keys.</div></aside></div>`;
}

const displayState = () => JSON.stringify([state, state.schedules.map(s=>scheduleRun(s,state.drafts)?.status)]);
function render() {
  signedIn ? shell() : login();
  renderedState = signedIn ? displayState() : '';
}
function lockStudio() {
  closeModal();github.disconnect();demo=false;signedIn=false;pending=null;
  state={drafts:[],schedules:[],operations:[]};edits.clear();editRevisions.clear();
  editorSnapshot=null;secretNames.clear();secretsLoaded=false;secretsError='';selectedDraft=null;
  promptEdits.clear();promptSnapshot=null;promptType='image';settingsView='connections';render();
}
window.addEventListener('studio-locked', lockStudio);
function navigate(page) { mobileNav=false; if(location.hash===`#${page}`) render();else location.hash=page; }

async function sync() {
  if (demo || !signedIn || polling) return;
  polling=true;
  try {
    state=await github.readState();
    if (pending) {
      const op=state.operations.find(x=>x.id===pending.id);
      if (op && ['complete','failed'].includes(op.status)) {
        const old=pending; pending=null;
        if(op.status==='failed') toast(op.error,true);
        else {
          if(old.promptType)promptEdits.delete(old.promptType);
          if(op.result && state.drafts.some(d=>d.id===op.result)) {
            selectedDraft=op.result;selectedType=currentDraft().type;edits.delete(op.result);editRevisions.delete(op.result);
          }
          toast(old.success);
        }
        render();
      }
    }
    // Refresh status pages when data or an overdue deadline changes. Keep open
    // editors and dialogs intact so polling cannot disturb an in-progress edit.
    if (!pending && ['overview','schedule','activity'].includes(route())
      && !document.querySelector('dialog[open]') && displayState() !== renderedState) render();
  } catch(error) { toast(error.message,true); }
  finally { polling=false; }
}

async function command(payload,label,success) {
  if(pending) return toast('Let the current request finish first.');
  const id=crypto.randomUUID();
  pending={id,label,success,started:Date.now(),promptType:payload.action==='save_prompt'?payload.type:null}; render();
  try {
    if(demo) {
      await new Promise(resolve=>setTimeout(resolve,450));
      const result=demoCommand(state,{...payload,id});
      if(result && state.drafts.some(d=>d.id===result)) {selectedDraft=result;selectedType=currentDraft().type;edits.delete(result);editRevisions.delete(result);}
      if(payload.action==='save_prompt')promptEdits.delete(payload.type);
      pending=null;render();toast(`${success} (demo only)`);
    } else {
      await github.dispatch({...payload,id});
      await sync();
    }
  } catch(error) {pending=null;render();toast(error.message,true);}
}

function draftCommand(action,extra={}) {
  const d=currentDraft();
  const snapshot=editorSnapshot?.id===d.id?editorSnapshot:{revision:d.revision,text:draftText(d)};
  return {action,draft_id:d.id,revision:snapshot.revision,text:snapshot.text,...extra};
}

function modal(title,description,body) {
  document.querySelector('#modal-root').innerHTML=`<dialog id="studio-dialog"><div class="modal-heading"><div><h2>${title}</h2><p>${description}</p></div><button class="icon-btn" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div>${body}</dialog>`;
  document.querySelector('#studio-dialog').showModal();
}
function closeModal() { document.querySelector('#studio-dialog')?.close();document.querySelector('#modal-root').innerHTML=''; }

function scheduleModal(id) {
  const schedule=state.schedules.find(s=>s.id===id) || {name:'',type:'image',time:'09:00',timezone:'Asia/Jerusalem',mode:'draft',days:[0,1,2,3,4],enabled:true};
  modal(id?'Edit your rhythm':'Make consistency simple','A recurring time for your next great post.',`<form id="schedule-form" data-id="${e(id||'')}"><label for="schedule-name">Schedule name</label><input id="schedule-name" name="name" value="${e(schedule.name)}" placeholder="e.g. Morning driving tips" maxlength="100" required /><div class="form-grid"><div><label for="schedule-type">Post format</label><select id="schedule-type" name="type">${Object.keys(typeNames).map(type=>`<option value="${type}" ${schedule.type===type?'selected':''}>${typeNames[type]}</option>`).join('')}</select></div><div><label for="schedule-time">Preferred time</label><input id="schedule-time" type="time" name="time" value="${e(schedule.time)}" required /></div></div><label>Repeat on</label><div class="day-picker">${dayNames.map((day,i)=>`<label><input type="checkbox" name="days" value="${i}" ${schedule.days.includes(i)?'checked':''}/><span>${day}</span></label>`).join('')}</div><label for="schedule-zone">Timezone</label><input id="schedule-zone" name="timezone" value="${e(schedule.timezone)}" list="timezones" required /><datalist id="timezones"><option value="Asia/Jerusalem"><option value="Europe/London"><option value="America/New_York"><option value="UTC"></datalist><label for="schedule-mode">When it’s time</label><select id="schedule-mode" name="mode"><option value="draft" ${schedule.mode==='draft'?'selected':''}>Prepare a draft for me to review</option><option value="publish" ${schedule.mode==='publish'?'selected':''}>Generate and publish automatically</option></select><p class="field-hint" id="mode-hint">${schedule.mode==='publish'?'This schedule publishes to Facebook without a manual review.':'The post will wait in your drafts until you choose to publish.'}</p><div id="schedule-error" class="form-error" role="alert"></div><div class="modal-actions">${id?`<button type="button" class="icon-btn danger" data-action="delete-schedule" data-id="${e(id)}" aria-label="Delete schedule">${icon('trash')}</button>`:''}<button type="button" class="btn secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">${icon('check')} Save schedule</button></div></form>`);
}

document.addEventListener('submit', async event=> {
  const form=event.target;
  if (!['login-form','schedule-form','one-time-form','settings-form','prompt-form'].includes(form.id)) return;
  event.preventDefault();
  const data=new FormData(form);
  if(form.id==='login-form') {
    const submit=form.querySelector('[type=submit]');submit.disabled=true;submit.textContent='Opening your studio…';
    try {
      await github.connect(config.gateway,String(data.get('password')));
      state=await github.readState();signedIn=true;demo=false;form.reset();
      render();if(route()==='settings')loadSecrets();
    } catch(error) { signedIn=false;github.disconnect();login(error.message); }
  }
  if(form.id==='prompt-form') {
    if(!promptSnapshot || pending)return;
    const value=promptSnapshot.text.trim();
    if(!value||value.length>8000)return toast('Enter a prompt of 1–8,000 characters.',true);
    await command({action:'save_prompt',type:promptSnapshot.type,prompt:value,revision:promptSnapshot.revision},'Saving your prompt…','Prompt saved. New posts will use these instructions.');
  }
  if(form.id==='schedule-form') {
    try {
      const days=data.getAll('days').map(Number);
      if(!days.length) throw new Error('Choose at least one day.');
      new Intl.DateTimeFormat('en',{timeZone:data.get('timezone')}).format();
      const schedule={name:data.get('name').trim(),type:data.get('type'),time:data.get('time'),timezone:data.get('timezone'),mode:data.get('mode'),days,enabled:state.schedules.find(s=>s.id===form.dataset.id)?.enabled??true};
      const id=form.dataset.id;closeModal();
      await command({action:'save_schedule',schedule,schedule_id:id||undefined},'Saving your schedule…','Schedule saved');
    } catch(error) {const target=document.querySelector('#schedule-error');if(target) target.textContent=error.message;else toast(error.message,true);}
  }
  if(form.id==='one-time-form') {
    try {
      const scheduled=inZone(data.get('date'),'Asia/Jerusalem');
      if(scheduled<=new Date()) throw new Error('Choose a time in the future.');
      closeModal();await command(draftCommand('schedule_draft',{scheduled_at:scheduled.toISOString()}),'Scheduling your post…','Post scheduled');
    } catch(error) {const target=document.querySelector('#one-time-error');if(target)target.textContent=error.message;else toast(error.message,true);}
  }
  if(form.id==='settings-form') {
    const submit=form.querySelector('[type=submit]');
    try {
      const values=Object.fromEntries([...data.entries()].map(([k,v])=>[k,v.trim()]).filter(([,v])=>v));
      if(!Object.keys(values).length) throw new Error('Enter at least one new value to save.');
      if(values.GOOGLE_SERVICE_ACCOUNT_JSON) {const parsed=JSON.parse(values.GOOGLE_SERVICE_ACCOUNT_JSON);if(!parsed.private_key||!parsed.client_email||parsed.type!=='service_account')throw new Error('Enter a valid Google service account JSON file.');}
      if(values.FB_PAGE_ID&&!/^\d+$/.test(values.FB_PAGE_ID)) throw new Error('The Facebook page ID should contain only numbers.');
      if(values.MODEL) {for(const field of ['OPENAI_MODEL','OPENAI_MODEL_VIDEO','OPENAI_MODEL_QUESTION'])values[field]=values.MODEL;delete values.MODEL;}
      submit.disabled=true;submit.textContent='Saving securely…';
      if(!demo) await github.saveSecrets(values);
      Object.keys(values).forEach(k=>secretNames.add(k));secretsLoaded=true;secretsError='';form.reset();render();toast(demo?'Credentials simulated. Nothing was saved.':'Credentials saved securely in GitHub Secrets');
    } catch(error) {const target=document.querySelector('#settings-error');if(target)target.textContent=error.message;else toast(error.message,true);submit.disabled=false;submit.innerHTML=icon('check')+' Save credentials';}
  }
});

document.addEventListener('input',event=> {
  if(event.target.id==='prompt-text'&&promptSnapshot&&!pending) {
    promptSnapshot.text=event.target.value;
    promptEdits.set(promptType,{text:promptSnapshot.text,revision:promptSnapshot.revision});
    document.querySelector('#prompt-count').textContent=`${promptSnapshot.text.length.toLocaleString()} / 8,000 characters`;
    document.querySelector('#prompt-state').textContent='Unsaved changes';
    document.querySelector('#prompt-form [type=submit]').disabled=!promptSnapshot.text.trim();
    document.querySelector('[data-action="discard-prompt"]').disabled=false;
    document.querySelector('#prompt-preview').disabled=true;
  }
  if(event.target.id==='caption'&&currentDraft()) {
    if(!editRevisions.has(selectedDraft))editRevisions.set(selectedDraft,editorSnapshot.revision);
    edits.set(selectedDraft,event.target.value);editorSnapshot.text=event.target.value;
    document.querySelector('#preview-caption').textContent=event.target.value;
    document.querySelector('#caption-count').textContent=`${event.target.value.length.toLocaleString()} characters`;
    document.querySelector('#edit-state').textContent='Unsaved changes';
  }
});
document.addEventListener('change',event=> {
  if(event.target.id==='draft-select') {selectedDraft=event.target.value;selectedType=currentDraft()?.type||selectedType;render();}
  if(event.target.id==='schedule-mode') document.querySelector('#mode-hint').textContent=event.target.value==='publish'?'This schedule publishes to Facebook without a manual review.':'The post will wait in your drafts until you choose to publish.';
});

document.addEventListener('click',async event=> {
  const navLink=event.target.closest('.nav-link[href]');
  if(navLink&&mobileNav) {mobileNav=false;if(navLink.getAttribute('href')===location.hash)render();}
  const button=event.target.closest('[data-action]');
  if(!button||button.disabled) return;
  const action=button.dataset.action;
  if(action==='demo') {demo=true;signedIn=true;state=demoState();selectedDraft=null;selectedType='image';navigate('overview');}
  if(action==='logout') lockStudio();
  if(action==='settings-view') {
    settingsView=button.dataset.view;render();
    if(settingsView==='connections'&&!demo&&!secretsLoaded)loadSecrets();
  }
  if(action==='prompt-type') {promptType=button.dataset.type;render();}
  if(action==='default-prompt') {
    promptEdits.set(promptType,{text:defaultPrompts[promptType],revision:promptSnapshot.revision});render();
  }
  if(action==='discard-prompt') {promptEdits.delete(promptType);render();}
  if(action==='menu') {mobileNav=!mobileNav;render();}
  if(action==='new') {selectedDraft=null;selectedType=button.dataset.type||'image';navigate('create');}
  if(action==='type') {selectedType=button.dataset.type;selectedDraft=null;render();}
  if(action==='open-draft') {selectedDraft=button.dataset.id;selectedType=currentDraft().type;navigate('create');}
  if(action==='generate') await command({action:'generate',type:selectedType},'Creating your draft…','Your draft is ready to review');
  if(action==='revert-edits') {edits.delete(selectedDraft);editRevisions.delete(selectedDraft);render();}
  if(action==='save-draft') await command(draftCommand('save_draft'),'Saving your draft…','Draft saved');
  if(action==='publish') {
    modal('Ready for your audience?',demo?'This is a demo. No post will be sent to Facebook.':'This publishes the selected media and the caption shown in your preview to Alfred Kor’s Facebook page.',`<div class="publish-summary">${typeIcon(currentDraft().type)}<strong>${e(currentDraft().source.name)}</strong></div><div class="modal-actions"><button class="btn secondary" data-action="close-modal">Keep editing</button><button class="btn primary" data-action="confirm-publish">${icon('send')} ${demo?'Simulate publishing':'Publish to Facebook'}</button></div>`);
  }
  if(action==='confirm-publish') {closeModal();await command(draftCommand('publish'),'Publishing your post…','Facebook accepted your post');}
  if(action==='delete-draft') modal('Let this idea go?','This deletes the draft and cancels its scheduled publication.',`<div class="modal-actions"><button class="btn secondary" data-action="close-modal">Keep draft</button><button class="btn danger-solid" data-action="confirm-delete-draft">Delete draft</button></div>`);
  if(action==='confirm-delete-draft') {closeModal();const payload=draftCommand('delete_draft');selectedDraft=null;await command(payload,'Deleting your draft…','Draft deleted');}
  if(action==='schedule-draft') {
    const future=new Date(Date.now()+3600000);const p=zonedParts(future,'Asia/Jerusalem');
    modal('Give this post its moment.','Choose a time in Israel. Your post will publish at the next schedule check after that time.',`<form id="one-time-form"><label for="post-date">Date & time · Asia/Jerusalem</label><input id="post-date" name="date" type="datetime-local" value="${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}" required /><div id="one-time-error" class="form-error" role="alert"></div><div class="modal-actions"><button class="btn secondary" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">${icon('calendar')} Schedule post</button></div></form>`);
  }
  if(action==='cancel-draft') await command(draftCommand('cancel_draft'),'Updating your draft…','Post moved back to drafts');
  if(action==='run-due') {
    if(!demo){await sync();if(!signedIn)return;}
    const tasks=dueTasks(state);
    modal('Run due tasks now?',demo?'This is a demo. No post will be sent to Facebook.':'Due posts set to publish will be sent to Facebook. Draft-only tasks will prepare a draft for review.',
      `${tasks.length?`<div class="run-due-list">${tasks.map(task=>`<div class="run-due-item">${typeIcon(task.type)}<div><strong>${e(task.name)}</strong><span>${e(formatDate(task.date))} · ${task.mode==='draft'?'Prepare a draft':task.kind==='draft'?'Publish saved post':'Generate and publish'}</span></div></div>`).join('')}</div>`:'<p class="field-hint">No tasks are currently due. You can still request a fresh check.</p>'}<p class="field-hint">The check uses your saved schedules when it starts. Paused, future, and expired recurring tasks are not forced to run. This usually takes about a minute.</p><div class="modal-actions"><button class="btn secondary" data-action="close-modal">Cancel</button><button class="btn primary" data-action="confirm-run-due">${icon('send')} ${demo?'Simulate due tasks':'Run due tasks'}</button></div>`);
  }
  if(action==='confirm-run-due') {closeModal();await command({action:'run_due'},'Running due tasks…','Schedule check finished. Review the results in Schedule and Activity.');}
  if(action==='new-schedule') scheduleModal();
  if(action==='edit-schedule') scheduleModal(button.dataset.id);
  if(action==='toggle-schedule') {const s=state.schedules.find(s=>s.id===button.dataset.id);await command({action:'toggle_schedule',schedule_id:s.id,enabled:!s.enabled},'Updating your schedule…',s.enabled?'Schedule paused':'Schedule resumed');}
  if(action==='delete-schedule') {const id=button.dataset.id;modal('Remove this schedule?','Future recurring runs will stop. Drafts already created will stay in your workspace.',`<div class="modal-actions"><button class="btn secondary" data-action="close-modal">Keep schedule</button><button class="btn danger-solid" data-action="confirm-delete-schedule" data-id="${e(id)}">Delete schedule</button></div>`);}
  if(action==='confirm-delete-schedule') {const id=button.dataset.id;closeModal();await command({action:'delete_schedule',schedule_id:id},'Removing your schedule…','Schedule removed');}
  if(action==='close-modal') closeModal();
  if(action==='filter') {activityFilter=button.dataset.filter;render();}
  if(action==='refresh') {if(!demo){await sync();render();if(!signedIn)return;}await command({action:'refresh'},'Checking publication status…','Publication status refreshed');}
  if(action==='watch-video') {
    const id=currentDraft().source.id;
    if(/^[\w-]+$/.test(id)) modal('Your selected video','Playback uses your Google Drive access.',`<iframe class="drive-player" src="https://drive.google.com/file/d/${e(id)}/preview" title="Selected video from Google Drive" allow="fullscreen" referrerpolicy="no-referrer"></iframe>`);
  }
});

window.addEventListener('hashchange',()=> {mobileNav=false;render();if(route()==='settings'&&signedIn&&!demo&&!secretsLoaded)loadSecrets();});
async function loadSecrets() {
  try {secretNames=await github.secretsStatus();secretsLoaded=true;}catch(error){secretsError=error.message;}
  if(signedIn&&route()==='settings'&&settingsView==='connections') {
    document.querySelectorAll('[data-secret]').forEach(el=> {
      const exists=secretNames.has(el.dataset.secret);el.textContent=exists?'Configured':'Not configured';el.classList.toggle('set',exists);
    });
    document.querySelector('#settings-error').textContent=secretsError;
  }
}
setInterval(sync,8000);
try {config=await fetch('./config.json',{cache:'no-store'}).then(r=>r.json());}catch{/* login reports a missing connection configuration */}
render();
