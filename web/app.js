import { t, locale, setLocale, languages, applyLocale, number, sourceMessage } from './i18n.js';
import './style.css';
import './mobile.css';
import './rtl.css';
import { icon } from './icons.js';
import defaultPrompts from '../prompts.json';
import * as github from './api.js';
import { demoState, demoCommand } from './demo.js';
import { activityItems, filterActivity } from './activity.js';
import { fileDetails, uploadFile, downloadUpload } from './uploads.js';
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
const mobileViewport = window.matchMedia('(max-width: 650px)');
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
let sourceMode = 'library';
let selectedUpload = null;
let uploadDescription = '';
let uploadError = '';
let uploading = null;
const uploadedMedia = new Map();
let mediaRequest = null;
const route = () => ['overview','create','schedule','activity','settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
const currentDraft = () => state.drafts.find(d => d.id === selectedDraft);
const draftText = draft => edits.get(draft.id) ?? draft.text;
const blocked = () => pending || uploading ? 'disabled' : '';
const badge = (status) => `<span class="badge ${e(status)}"><i></i>${e({draft:t("Draft"),scheduled:t("Scheduled"),preparing:t("Preparing"),publishing:t("Publishing"),processing:t("Processing"),published:t("Published"),failed:t("Needs attention"),uncertain:t("Check Facebook"),deleted:t("Deleted"),running:t("In progress"),complete:t("Complete"),waiting:t("Waiting for worker"),overdue:t("Overdue"),missed:t("Missed")}[status] || status)}</span>`;
const typeIcon = (type) => `<span class="type-icon ${e(type)}">${icon(type)}</span>`;
const brand = () => `<div class="brand"><span class="brand-symbol">${icon('leaf')}</span><span>alfred<span class="brand-dot">.</span></span></div>`;

function languagePicker() {
  return `<label class="language-picker"><span class="sr-only">${e(t('Interface language'))}</span><select id="ui-language" data-language aria-label="${e(t('Interface language'))}">${Object.entries(languages).map(([code,name])=>`<option value="${code}" lang="${code}" ${code===locale()?'selected':''}>${name}</option>`).join('')}</select></label>`;
}

function toast(message, error = false) {
  const el = document.querySelector('#toast');
  el.textContent = t(sourceMessage(message));
  el.className = `visible ${error ? 'error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = '', 6500);
}

function login(error = '') {
  root.innerHTML = `<div class="login-layout">
    <section class="login-story">${brand()}<div class="login-copy"><span class="eyebrow">${e(t("YOUR OWN LITTLE PUBLISHING STUDIO"))}</span><h1>${e(t("Good content."))}<br>${e(t("A little more"))}<br><em>${e(t("consistently."))}</em></h1><p>${e(t("Turn your ideas into a steady rhythm of posts."))}<br>${e(t("Plan, preview, and publish. All in one place."))}</p><div class="login-types"><span>${icon('image')}${e(t("Photos"))}</span><span>${icon('video')}${e(t("Videos"))}</span><span>${icon('question')}${e(t("Questions"))}</span></div></div><div class="login-footer">${e(t("Made for Alfred Kor"))} <span>${e(t("Powered by GitHub"))} ${icon('github')}</span></div><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div></section>
    <section class="login-panel"><div class="login-form-wrap"><div class="login-language">${languagePicker()}</div><span class="lock-tile">${icon('lock')}</span><span class="eyebrow">ALFRED STUDIO</span><h2>${e(t("A space of your own."))}</h2><p>${e(t("Enter your password to open your studio."))}</p>
      <form id="login-form"><label for="studio-password">${e(t("Password"))}</label><input id="studio-password" name="password" type="password" placeholder="${e(t("Your studio password"))}" required autocomplete="current-password" spellcheck="false" autofocus />
      <div id="login-error" class="form-error" role="alert">${e(t(sourceMessage(error)))}</div><button class="btn primary login-submit" type="submit">${e(t("Open studio"))} ${icon('arrow')}</button></form>
      <div class="login-note">${icon('lock')}<span>${e(t("One password. Your own private workspace."))}<br>${e(t("Close or refresh this tab to lock the studio."))}</span></div><div class="login-divider"><span>${e(t("just looking around?"))}</span></div><button class="btn demo-btn" data-action="demo">${e(t("Explore the demo"))} ${icon('arrow')}</button><small class="muted demo-caption">${e(t("Sample content. No real posts or API calls."))}</small>
    </div></section></div>`;
}

function pendingDetails() {
  const seconds = Math.max(0, Math.floor((Date.now() - pending.started) / 1000));
  const slow = seconds >= 180;
  const phase = pending.phase;
  const stage = demo ? t("Demo in progress") : ({sending:t("Sending request"),queued:t("Waiting for GitHub"),running:t("In progress")}[phase]);
  const message = demo ? t("Simulating your request. No real post will be sent.")
    : phase === 'sending' ? t("Sending your request to GitHub. Please keep this tab open.")
    : phase === 'running' ? (slow ? t("Still running. Some requests take longer; the result will appear here automatically.") : t("Your request has started. The result will appear here automatically."))
    : slow ? t("GitHub is taking longer to start. Your request is already sent; no need to submit it again.")
    : t("GitHub may take a few minutes to start. Keep this tab open; it updates automatically.");
  return {stage, message, elapsed: t('Elapsed {minutes}m {seconds}s',{minutes:number(Math.floor(seconds/60)),seconds:new Intl.NumberFormat(locale(),{minimumIntegerDigits:2}).format(seconds%60)})};
}

function pendingBanner() {
  if (!pending) return '';
  const info = pendingDetails();
  return `<aside class="pending-banner" aria-label="${e(t("Request progress"))}"><span class="spinner" aria-hidden="true"></span><div class="pending-copy" role="status" aria-live="polite" aria-atomic="true"><span class="pending-stage">${e(info.stage)}</span><strong>${e(t(pending.label))}</strong><p class="pending-message">${e(info.message)}</p></div><div class="pending-meta"><span class="pending-elapsed" role="timer" aria-live="off">${e(info.elapsed)}</span>${demo?'':`<a href="https://github.com/${e(github.repoName())}/actions/workflows/studio.yml" target="_blank" rel="noopener noreferrer">${e(t("View on GitHub"))} ${icon('external')}</a>`}</div></aside>`;
}

function updatePending() {
  if (!pending || !signedIn) return;
  const info = pendingDetails();
  for (const name of ['stage','message','elapsed']) {
    const el = document.querySelector(`.pending-${name}`);
    if (el && el.textContent !== info[name]) el.textContent = info[name];
  }
}

function shell() {
  const page = route();
  const labels = {overview:t("Overview"),create:t("Create a post"),schedule:t("Schedule"),activity:t("Activity"),settings:t("Settings")};
  const nav = [['create','plus'],['overview','grid'],['schedule','calendar'],['activity','activity']];
  root.innerHTML = `<div class="app-layout ${mobileNav ? 'nav-open' : ''}">
    <div class="nav-scrim" data-action="close-menu" aria-hidden="true"></div><aside class="sidebar" id="studio-navigation">${brand()}<div class="workspace-card"><div class="avatar">AK</div><div><strong>Alfred Kor</strong><span><b class="facebook-mini">f</b> ${e(t("Facebook page"))}</span></div>${icon('chevron')}</div>
    <span class="nav-label">${e(t("WORKSPACE"))}</span><nav aria-label="${e(t("Main navigation"))}">${nav.map(([id,ico]) => `<a href="#${id}" class="nav-link ${id==='create'?'nav-create':''} ${page===id?'active':''}" ${page===id?'aria-current="page"':''}>${icon(ico)}${labels[id]}${id==='create'?'<span class="nav-shortcut" aria-hidden="true">+</span>':''}</a>`).join('')}</nav>
    <div class="sidebar-bottom"><div class="sidebar-note">${icon('leaf')}<strong>${e(t("A good rhythm goes a long way."))}</strong><p>${e(t("Keep your page active."))}<br>${e(t("Keep your time for you."))}</p></div><a href="#settings" class="nav-link ${page==='settings'?'active':''}">${icon('settings')}${e(t("Settings"))}</a><button class="nav-link" data-action="logout">${icon('logout')}${demo?t("Exit demo"):t("Lock studio")}</button><div class="connection-status"><i></i>${demo?t("Demo workspace"):t("Studio connected")}${icon('github')}</div></div></aside>
    <div class="workspace"><header class="topbar"><div class="breadcrumb"><button class="icon-btn mobile-menu" data-action="menu" aria-label="${e(t("Toggle navigation"))}" aria-controls="studio-navigation" aria-expanded="${mobileNav}">${icon('menu')}</button><span>${e(t("Workspace"))}</span>${icon('chevron')}<strong>${labels[page]}</strong></div><div class="topbar-end">${languagePicker()}<span class="timezone">${icon('globe')} Asia/Jerusalem</span><span class="session-pill">${icon(demo?'info':'lock')}${demo?t("Demo mode"):t("Private studio")}</span><div class="small-avatar">AK</div></div></header>
    ${demo?`<div class="demo-banner"><span><strong>${e(t("A look around your future studio."))}</strong> ${e(t("You’re using sample content."))}</span><button data-action="logout">${e(t("Open your studio"))} `+icon('arrow')+'</button></div>':''}
    <main id="main-content">${pendingBanner()}
    ${{overview:overview,create:composer,schedule:schedulePage,activity:activityPage,settings:settingsPage}[page]()}</main>
    <footer class="workspace-footer"><span>Alfred Studio <span class="footer-dot">·</span> ${e(t("A little more consistent."))}</span><span>${icon('clock')} ${e(t("Times shown in Israel time unless specified"))}</span></footer></div></div>`;
}

function heading(kicker,title,description,action='') {
  return `<div class="page-heading"><div><span class="eyebrow">${kicker}</span><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
}

function overview() {
  const drafts = state.drafts.filter(d => ['draft','failed'].includes(d.status));
  const published = state.drafts.filter(d => d.status === 'published');
  const scheduled = state.schedules.filter(s => s.enabled);
  const today = new Intl.DateTimeFormat(locale(),{weekday:'long',month:'long',day:'numeric',timeZone:'Asia/Jerusalem'}).format(new Date());
  return `${heading(e(today.toUpperCase()),t("Your content, on autopilot."),t("A clear head. A full content calendar. A little time back."),`<button class="btn primary" data-action="new">${icon('plus')} ${e(t("Create a post"))}</button>`)}
    <section class="stats-grid" aria-label="${e(t("Workspace totals"))}">${[[published.length,t("Posts published"),'send',t("Your ideas, out in the world")],[drafts.length,t("Drafts to review"),'edit',t("A fresh perspective is waiting")],[scheduled.length,t("Active schedules"),'calendar',t("A rhythm that works for you")]].map(([n,label,ico,note])=>`<div class="stat-card"><div><span class="stat-label">${label}</span><strong>${new Intl.NumberFormat(locale(),{minimumIntegerDigits:2}).format(n)}</strong><small>${note}</small></div><span class="stat-icon">${icon(ico)}</span></div>`).join('')}</section>
    ${weeklyCalendar(true)}
    <div class="overview-grid">
    <section class="panel next-panel"><div class="section-title"><h2>${e(t("Coming up next"))}</h2><a href="#schedule" class="text-link">${e(t("View all"))} ${icon('arrow')}</a></div>${upcomingRows()}<div class="cadence-note">${icon('clock')} ${e(t("Checks are requested every 30 minutes. Delayed posts can catch up within 24 hours."))}</div></section>
    <section class="panel drafts-panel"><div class="section-title"><div><h2>${e(t("On your desk"))} <span class="count-chip">${drafts.length}</span></h2><p>${e(t("A few words away from ready."))}</p></div><a class="text-link" href="#create">${e(t("Open drafts"))} ${icon('arrow')}</a></div>${drafts.length?drafts.slice(0,3).map(d=>draftRow(d)).join(''):empty('edit',t("Room for your next idea"),t("Create a photo, video, or question post to get started."))}</section></div>`;
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
  return items.length ? items.map(item=>`<div class="upcoming-row">${typeIcon(item.type)}<div><strong dir="auto">${e(item.name)}</strong><span>${e(formatDate(item.date))} <b>·</b> ${item.status?e({waiting:t("Waiting for worker"),overdue:t("Overdue · waiting for worker"),missed:t("Missed · needs attention")}[item.status]):item.mode==='draft'?t("Prepare draft"):t("Auto-publish")}</span></div>${icon('chevron')}</div>`).join('') : empty('calendar',t("Find your rhythm"),t("Add a recurring schedule or choose a time for a finished draft."));
}

function draftRow(draft) {
  return `<button class="draft-row" data-action="open-draft" data-id="${e(draft.id)}">${typeIcon(draft.type)}<div class="draft-row-main"><strong dir="auto">${e(draft.source.name)}</strong><span>${e(typeNames[draft.type])} <b>·</b> ${e(formatDate(draft.created_at))}</span></div>${badge(draft.status)}<span class="draft-open">${e(t("Review"))} ${icon('arrow')}</span></button>`;
}

function empty(ico,title,description) { return `<div class="empty-state">${icon(ico)}<strong>${title}</strong><p>${description}</p></div>`; }

function sourcePanel() {
  const selection = selectedUpload;
  return `<div class="panel source-panel"><div class="step-title"><span>01</span><h2>${e(t("Choose your source"))}</h2></div>
    <div class="source-picker" role="group" aria-label="${e(t("Post source"))}">${[['library',t("Existing resources")],['upload',t("Upload image or video")]].map(([mode,label])=>`<button type="button" data-action="source-mode" data-mode="${mode}" aria-pressed="${sourceMode===mode}" class="${sourceMode===mode?'selected':''}" ${blocked()}>${label}</button>`).join('')}</div>
    ${sourceMode==='library'?`<div class="format-picker">${Object.keys(typeNames).map(type=>`<button class="format-option ${selectedType===type?'selected':''}" data-action="type" data-type="${type}" aria-pressed="${selectedType===type}" ${blocked()}>${icon(type)}${typeNames[type]}${selectedType===type?'<span class="selected-dot"></span>':''}</button>`).join('')}</div><p class="field-hint">${{image:t("A photo from your Drive folder, with a fresh Hebrew caption."),video:t("A video from your Drive folder, with a caption to match."),question:t("A question and its image from Google Forms, with the original answers.")}[selectedType]}</p><button class="btn primary generate-btn" data-action="generate" ${blocked()}>${icon('spark')} ${e(t({image:'Generate photo draft',video:'Generate video draft',question:'Generate question draft'}[selectedType]))}</button>`:
    `<form id="upload-form"><div class="upload-dropzone"><label for="media-upload">${e(t("Choose an image or video"))}</label><input id="media-upload" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,.mov" ${blocked()} /><p class="field-hint">${e(t("Or drop a file here. JPG, PNG, WebP up to 10 MB; MP4 or MOV up to 50 MB."))}</p></div>
    ${selection?`<div class="upload-selection">${selection.details.type==='image'?`<img src="${e(selection.url)}" alt="${e(t("Selected upload preview"))}" />`:`<video src="${e(selection.url)}" controls playsinline preload="metadata" aria-label="${e(t("Selected upload preview"))}"></video>`}<div><strong>${e(selection.file.name)}</strong><span>${selection.file.size<1024*1024?`${Math.ceil(selection.file.size/1024)} KB`:`${(selection.file.size/1024/1024).toFixed(1)} MB`} · ${e(typeNames[selection.details.type])}</span><button type="button" class="text-link" data-action="remove-upload" ${blocked()}>${e(t("Remove file"))}</button></div></div>`:''}
    <label for="upload-description">${e(t("Describe your image or video"))}</label><textarea id="upload-description" dir="auto" maxlength="2000" rows="3" required placeholder="${e(t("For example: Practicing parallel parking with a beginner."))}" ${blocked()}>${e(uploadDescription)}</textarea><p class="field-hint">${e(t("A few words are enough. Your description and saved writing instructions guide the caption."))}</p>
    <div id="upload-error" class="form-error" role="alert">${e(uploadError)}</div>
    ${uploading?`<div id="upload-progress" role="status">${e(t('Saving your upload… {progress}%',{progress:number(uploading.progress)}))}</div><button type="button" class="text-link" data-action="cancel-upload">${e(t("Cancel upload"))}</button>`:''}
    <button class="btn primary generate-btn" type="submit" ${blocked()||(!selection||!uploadDescription.trim()?'disabled':'')}>${icon('spark')} ${e(t("Generate caption"))}</button></form>`}
    <div class="micro-note">${e(t("Creates a preview. You decide when to publish."))}</div></div>`;
}

function composer() {
  const draft = currentDraft();
  editorSnapshot = draft ? {id: draft.id, revision: editRevisions.get(draft.id) ?? draft.revision, text: draftText(draft)} : null;
  const available = state.drafts.filter(d=>['draft','scheduled','failed'].includes(d.status));
  const canEdit = editable(draft);
  return `${heading(t("CREATE & PREVIEW"),t("Good ideas, ready to share."),t("Pick a format, make it yours, and see exactly what goes out."))}
    <div class="composer-layout"><section class="composer-controls">${sourcePanel()}
    <div class="panel caption-panel"><div class="step-title"><span>02</span><h2>${e(t("Make it yours"))}</h2>${draft?badge(draft.status):''}</div>
    ${available.length?`<label for="draft-select">${e(t("Open a saved draft"))}</label><select id="draft-select"><option value="">${e(t("Choose a draft…"))}</option>${available.map(d=>`<option value="${e(d.id)}" ${d.id===selectedDraft?'selected':''}>${e(typeNames[d.type])} · ${e(d.source.name)}</option>`).join('')}</select>`:''}
    ${draft?`<div class="source-label">${icon(draft.type)}<span>${e(draft.source.name)}</span>${sourceUrl(draft.source.url)?`<a href="${e(sourceUrl(draft.source.url))}" target="_blank" rel="noopener noreferrer" aria-label="${e(t("Open original media"))}">${icon('external')}</a>`:''}</div><label for="caption">${e(t("Post caption"))} <span>${e(t("Hebrew supported"))}</span></label><textarea id="caption" dir="auto" maxlength="12000" ${canEdit&&!pending?'':'readonly'}>${e(draftText(draft))}</textarea><div class="caption-meta"><span id="caption-count">${e(t('{count} characters',{count:number(draftText(draft).length)}))}</span><span id="edit-state">${edits.has(draft.id)?t("Unsaved changes"):t("Saved draft")}</span></div>
    ${draft.error?`<div class="form-error">${e(t(sourceMessage(draft.error)))}</div>`:''}${draft.status==='scheduled'?`<div class="inline-note">${icon('calendar')} ${e(t('Scheduled for {date}',{date:formatDate(draft.scheduled_at)}))}</div>`:''}
    ${canEdit?`<div class="editor-actions"><button class="text-link" data-action="revert-edits" ${blocked()}>${e(t("Revert edits"))}</button><button class="btn secondary" data-action="save-draft" ${blocked()}>${icon('check')} ${e(t("Save draft"))}</button><button class="icon-btn danger" data-action="delete-draft" aria-label="${e(t("Delete draft"))}" ${blocked()}>${icon('trash')}</button></div>`:''}`:empty('edit',t("A fresh draft starts here"),t("Generate a post or open a saved draft to edit the caption."))}</div>
    ${draft&&canEdit?`<div class="publish-actions"><button class="btn secondary" data-action="schedule-draft" ${blocked()}>${icon('calendar')} ${draft.status==='scheduled'?t("Change time"):t("Schedule post")}</button><button class="btn primary" data-action="publish" ${blocked()}>${icon('send')} ${e(t("Publish now"))}</button></div>${draft.status==='scheduled'?`<button class="text-link cancel-schedule" data-action="cancel-draft" ${blocked()}>${e(t("Move back to drafts"))}</button>`:''}`:''}</section>
    <section class="preview-column"><div class="preview-heading"><span class="eyebrow">${e(t("LIVE PREVIEW"))}</span><span><b class="facebook-mini">f</b> Facebook</span></div><article class="facebook-card"><div class="facebook-header"><div class="avatar">AK</div><div><strong>מורה נהיגה - אלפרד קור</strong><span>${demo?t("Demo preview"):t("Post preview")} · ${icon('globe')}</span></div><span class="facebook-more">···</span></div><div id="preview-caption" class="preview-caption" dir="auto">${draft?e(draftText(draft)):t("Your next post starts with an idea.\nGenerate a draft to see it here.")}</div>${mediaPreview(draft)}<div class="facebook-reactions"><span>♡</span><span>${e(t("Like"))}</span><span>${e(t("Comment"))}</span><span>${e(t("Share"))}</span></div></article><p class="preview-note">${icon('info')} ${e(t("A close preview of your post. Facebook may display media and line breaks differently."))}</p>${draft?.facebook_url?`<a class="btn secondary" href="${e(sourceUrl(draft.facebook_url))}" target="_blank" rel="noopener noreferrer">${e(t("View on Facebook"))} ${icon('external')}</a>`:''}</section></div>`;
}

function mediaPreview(draft) {
  if (!draft) return `<div class="media-placeholder">${icon('image')}<span>${e(t("Your media will appear here"))}</span></div>`;
  if (draft.type==='video') return `<div class="video-preview"><div class="video-pattern"></div><span class="video-play">${icon('play')}</span><strong dir="auto">${e(draft.source.name)}</strong><span>${draft.source.upload_id?t("Your uploaded video"):demo?t("Sample video preview"):t("Your selected Drive video")}</span>${draft.source.upload_id||sourceUrl(draft.source.url)?`<button class="btn" data-action="watch-video" data-id="${e(draft.id)}">${e(t("Watch selected video"))} ${icon('external')}</button>`:''}</div>`;
  if (demo && draft.source.upload_id && uploadedMedia.has(draft.source.upload_id)) return `<img class="post-image" src="${e(uploadedMedia.get(draft.source.upload_id))}" alt="${e(draft.source.name)}" />`;
  const src = draft.preview;
  if (src && (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(src) || demo&&src==='./road.svg')) return `<img class="post-image" src="${e(src)}" alt="${e(draft.source.name)}" />`;
  return `<div class="media-placeholder">${icon(draft.type)}<span>${draft.status==='published'?t("No saved image preview"):e(draft.source.name)}</span>${sourceUrl(draft.source.url)?`<a class="text-link" href="${e(sourceUrl(draft.source.url))}" target="_blank" rel="noopener noreferrer">${e(t("Open original"))} ${icon('external')}</a>`:''}</div>`;
}

function weeklyCalendar(onOverview = false) {
  return `<section class="panel week-panel"><div class="section-title"><div><h2>${onOverview?t("Publishing calendar"):t("Your weekly rhythm")}</h2><p>${e(t("Recurring schedules · each schedule’s local time"))}</p></div>${onOverview?`<a href="#schedule" class="text-link">${e(t("Manage schedules"))} ${icon('arrow')}</a>`:''}</div><div class="week-grid">${dayNames().map((day,i)=>`<div class="week-day"><div class="week-day-label">${day}<span>${state.schedules.filter(s=>s.enabled&&s.days.includes(i)).length||'—'}</span></div>${state.schedules.filter(s=>s.enabled&&s.days.includes(i)).map(s=>`<button class="week-event ${e(s.type)}" ${blocked()} data-action="edit-schedule" data-id="${e(s.id)}"><span>${icon(s.type)}${e(s.time)}</span><strong dir="auto">${e(s.name)}</strong><small>${s.mode==='draft'?t("Draft"):t("Publish")}</small></button>`).join('')}</div>`).join('')}</div></section>`;
}

function schedulePage() {
  const queued = state.drafts.filter(d=>d.status==='scheduled');
  return `${heading(t("YOUR PUBLISHING RHYTHM"),t("A little planning. A lot of freedom."),t("Set it up once. Keep showing up for your audience."),`<button class="btn primary" data-action="new-schedule" ${blocked()}>${icon('plus')} ${e(t("Add a schedule"))}</button>`)}
    <div class="schedule-info">${icon('clock')}<div><strong>${e(t("Delayed posts stay on the schedule."))}</strong><span>${e(t("Checks are requested every 30 minutes, but GitHub can start them late. The latest recurring post catches up within 24 hours; older missed runs need your attention."))}</span><span>${state.scheduler?.last_finished_at?e(t('Last completed check: {date}',{date:formatDate(state.scheduler.last_finished_at)})):t("No completed schedule check recorded yet.")}</span></div><button class="btn secondary run-due-trigger" data-action="run-due" ${blocked()}>${icon('send')} ${e(t("Run due tasks now"))}</button></div>
    ${weeklyCalendar()}
    <section class="schedules-list"><div class="section-title"><h2>${e(t("Recurring schedules"))} <span class="count-chip">${state.schedules.length}</span></h2></div>${state.schedules.length?state.schedules.map(scheduleCard).join(''):empty('calendar',t("Make room for consistency"),t("Add your first schedule. You can prepare drafts or publish automatically."))}</section>
    ${queued.length?`<section class="panel"><div class="section-title"><h2>${e(t("One-time posts"))}</h2><span class="muted">${e(t("Ready for their moment"))}</span></div>${queued.sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at)).map(d=>`<div class="one-time-row">${draftRow(d)}<span class="muted">${e(formatDate(d.scheduled_at))}</span></div>`).join('')}</section>`:''}`;
}

function scheduleCard(s) {
  const run=scheduleRun(s,state.drafts);
  const message=run?.error || ({waiting:t("Waiting for the next worker check."),overdue:t("The worker is delayed. This run can still catch up within 24 hours."),missed:t("This run needs review. Open Needs attention in Activity to prepare a missed draft.")}[run?.status] || t("Latest run"));
  return `<article class="schedule-card ${s.enabled?'':'paused-card'}">${typeIcon(s.type)}<div class="schedule-card-main"><div><h3 dir="auto">${e(s.name)}</h3><span class="badge ${s.enabled?'active':'paused'}"><i></i>${s.enabled?t("Active"):t("Paused")}</span></div><p>${e(s.days.map(d=>dayNames()[d]).join(', '))} <b>·</b> ${e(s.time)} <b>·</b> ${e(s.timezone)} <b>·</b> ${s.mode==='draft'?t("Prepare a draft"):t("Publish automatically")}</p>${run?`<div class="schedule-run">${badge(run.status)}<span>${e(formatDate(run.date))} · ${e(message)}</span></div>`:''}</div><div class="schedule-card-actions"><button class="icon-btn" data-action="edit-schedule" data-id="${e(s.id)}" aria-label="${e(t('Edit {name}',{name:s.name}))}" ${blocked()}>${icon('edit')}</button><button class="switch ${s.enabled?'on':''}" role="switch" aria-checked="${s.enabled}" aria-label="${e(t('Enable {name}',{name:s.name}))}" data-action="toggle-schedule" data-id="${e(s.id)}" ${blocked()}><span></span></button></div></article>`;
}

function operationName(action) {
  const names = {generate:'Generate caption',generate_upload:'Generate caption',publish:'Publish now',
    save_draft:'Save draft',delete_draft:'Delete draft',schedule_draft:'Schedule post',cancel_draft:'Move back to drafts',
    save_schedule:'Save schedule',toggle_schedule:'Schedule',delete_schedule:'Delete schedule',
    save_prompt:'Save prompt',refresh:'Refresh status',run_due:'Run due tasks',recover_missed:'Prepare missed draft'};
  return t(names[action] || action.replaceAll('_',' '));
}

function activityPage() {
  const all = activityItems(state);
  const filtered = filterActivity(all,activityFilter);
  const failedOps = state.operations.filter(op=>op.status==='failed'&&op.action!=='missed_schedule');
  return `${heading(t("THE BIGGER PICTURE"),t("Every post has a story."),t("See what’s published, what’s on its way, and what needs a little attention."),`<button class="btn secondary" data-action="refresh" ${blocked()}>${icon('refresh')} ${e(t("Refresh status"))}</button>`)}
    <div class="filter-bar activity-filters" role="group" aria-label="${e(t("Filter activity"))}">${[['all',t("All activity")],['published',t("Published")],['scheduled',t("Scheduled")],['attention',t("Needs attention")]].map(([value,label])=>`<button data-action="filter" data-filter="${value}" aria-pressed="${activityFilter===value}" class="${activityFilter===value?'selected':''}">${label} <span>${filterActivity(all,value).length}</span></button>`).join('')}</div>
    ${activityFilter==='attention'?`<p class="activity-help">${e(t("Overdue tasks, missed runs, and posts needing review stay here until handled. Upcoming posts appear under Scheduled."))}</p>`:''}
    <section class="activity-feed">${filtered.length?filtered.map(activityCard).join(''):empty('activity',activityFilter==='published'?t("No published posts yet"):t("Nothing here right now"),activityFilter==='published'?t("Posts published through Alfred Studio appear here with their saved content."):t("Your posts and scheduled tasks will appear here."))}</section>
    ${['all','attention'].includes(activityFilter)&&failedOps.length?`<section class="panel operation-panel"><div class="section-title"><h2>${e(t("Recent workflow issues"))}</h2>${demo?'':`<a class="text-link" href="https://github.com/${e(github.repoName())}/actions" target="_blank" rel="noopener noreferrer">${e(t("Open GitHub Actions"))} ${icon('external')}</a>`}</div>${failedOps.map(op=>`<div class="operation-row"><span class="error-dot"></span><div><strong>${e(operationName(op.action))}</strong><p>${e(t(sourceMessage(op.error)))}</p></div><span class="muted">${e(formatDate(op.created_at))}</span></div>`).join('')}</section>`:''}`;
}

function activityCard(item) {
  if(item.kind==='post') {
    const d=item.draft;
    return `<article class="panel activity-post" data-post-id="${e(d.id)}"><header class="activity-post-header">${typeIcon(d.type)}<div class="activity-main"><strong dir="auto">${e(d.source.name)}</strong><span>${e(typeNames[d.type])} · ${e(formatDate(item.date))}</span></div>${badge(item.status)}</header>${d.error?`<p class="activity-error">${e(t(sourceMessage(d.error)))}</p>`:''}<div class="activity-post-content"><div class="activity-media">${mediaPreview(d)}</div><p class="activity-caption" dir="auto">${e(d.text)}</p></div><footer class="activity-post-actions"><button class="text-link" data-action="open-draft" data-id="${e(d.id)}">${icon(editable(d)?'edit':'chevron')} ${editable(d)?t("Review post"):t("Open full post")}</button>${sourceUrl(d.facebook_url)?`<a class="text-link" href="${e(sourceUrl(d.facebook_url))}" target="_blank" rel="noopener noreferrer">${e(t("View on Facebook"))} ${icon('external')}</a>`:''}</footer></article>`;
  }
  const exists=state.schedules.some(s=>s.id===item.scheduleId);
  const message={scheduled:item.mode==='draft'?t("Will prepare a draft for review."):t("Will publish when its time arrives."),waiting:t("Ready for the next worker check."),overdue:t("Waiting for the worker. You can run due tasks now."),missed:t("This run is saved for recovery. Prepare a draft, review it, and publish when ready."),failed:item.error||t("The draft could not be prepared. Try preparing it again after fixing the issue.")}[item.status];
  return `<article class="panel activity-task"><header class="activity-post-header">${typeIcon(item.type)}<div class="activity-main"><strong dir="auto">${e(item.name)}</strong><span>${e(typeNames[item.type])} · ${e(formatDate(item.date))}</span></div>${badge(item.status)}</header><p class="activity-help">${e(message)}</p><div class="activity-post-actions">${['missed','failed'].includes(item.status)?`<button class="btn secondary" data-action="recover-missed" data-id="${e(item.missedId||'')}" data-schedule-id="${e(item.scheduleId)}" data-slot="${e(item.slot)}" ${blocked()}>${icon('edit')} ${e(t("Prepare missed draft"))}</button>`:['waiting','overdue'].includes(item.status)?`<button class="btn secondary" data-action="run-due" ${blocked()}>${icon('send')} ${e(t("Run due tasks now"))}</button>`:''}${exists?`<button class="text-link" data-action="edit-schedule" data-id="${e(item.scheduleId)}" ${blocked()}>${e(t("Edit schedule"))} ${icon('chevron')}</button>`:''}</div></article>`;
}

function settingsPage() {
  const prompts = settingsView === 'prompts';
  return `${heading(t("MAKE YOURSELF AT HOME"), prompts?t("Your voice, in every post."):t("The keys to your studio."), prompts?t("Shape the tone, language, and style of each kind of post."):t("Update your connections in one place. Saved keys stay private."))}
    <div class="filter-bar settings-views" role="group" aria-label="${e(t("Settings sections"))}">${[['connections',t("Connections")],['prompts',t("AI prompts")]].map(([view,label])=>`<button data-action="settings-view" data-view="${view}" aria-pressed="${settingsView===view}" class="${settingsView===view?'selected':''}" ${blocked()}>${label}</button>`).join('')}</div>
    ${prompts?promptsPage():connectionsPage()}`;
}

function promptsPage() {
  const edit=promptEdits.get(promptType);
  const text=edit?.text??state.prompts?.[promptType]??defaultPrompts[promptType];
  promptSnapshot={type:promptType,text,revision:edit?.revision??state.prompt_revisions?.[promptType]??0};
  return `<div class="settings-layout"><form id="prompt-form" class="panel prompt-panel">
    <div class="section-title"><div><h2>${e(t("Caption instructions"))}</h2><p>${e(t("A separate prompt for each post format."))}</p></div>${icon('spark')}</div>
    <div class="format-picker" role="group" aria-label="${e(t("Prompt format"))}">${Object.entries(typeNames).map(([type,label])=>`<button type="button" class="format-option ${promptType===type?'selected':''}" data-action="prompt-type" data-type="${type}" aria-pressed="${promptType===type}" ${blocked()}>${icon(type)}${label}${promptEdits.has(type)?`<span class="prompt-unsaved" title="${e(t("Unsaved changes"))}">${e(t("Edited"))}</span>`:''}</button>`).join('')}</div>
    <label for="prompt-text">${e(t({image:'Photo prompt',video:'Video prompt',question:'Question prompt'}[promptType]))}</label><textarea id="prompt-text" name="prompt" dir="auto" maxlength="8000" rows="16" required spellcheck="false" ${pending?'readonly':''}>${e(text)}</textarea>
    <div class="caption-meta"><span id="prompt-count">${e(t('{count} / {limit} characters',{count:number(text.length),limit:number(8000)}))}</span><span id="prompt-state" role="status">${edit?t("Unsaved changes"):text===defaultPrompts[promptType]?t("Default prompt"):t("Saved custom prompt")}</span></div>
    <p class="field-hint">${promptType==='question'?t("This prompt controls the introduction. The original question, every answer choice, and course links are added automatically."):t("The current date and selected media details are added automatically. Write instructions for the caption you want.")}</p>
    <div class="prompt-tools"><button type="button" class="text-link" data-action="default-prompt" ${blocked()}>${icon('refresh')} ${e(t("Restore default"))}</button><button type="button" class="text-link" data-action="discard-prompt" ${pending||!edit?'disabled':''}>${e(t("Discard changes"))}</button></div>
    <div class="settings-save prompt-save"><span>${icon('lock')} ${e(t("Saved privately for future posts."))}</span><button type="submit" class="btn primary" ${pending||!edit||!text.trim()?'disabled':''}>${icon('check')} ${e(t("Save prompt"))}</button></div>
  </form><aside class="settings-aside"><div class="panel security-note"><span class="lock-tile">${icon('spark')}</span><h3>${e(t("Make it sound like you."))}</h3><p>${e(t("Describe your preferred language, tone, caption length, contact details, and call to action."))}</p><p>${e(t("Save each format separately. Restoring a default takes effect after you save it."))}</p></div><div class="panel security-note"><h3>${e(t("Save. Generate. Preview."))}</h3><p>${e(t("New drafts and recurring posts use the latest saved prompt. Existing drafts keep the captions you already reviewed."))}</p><button id="prompt-preview" type="button" class="btn secondary" data-action="new" data-type="${promptType}" ${pending||edit?'disabled':''}>${icon('edit')} ${e(t("Preview a new post"))}</button><p>${demo?t("Demo saves are temporary. Generated demo captions remain sample text."):t("A generation already in progress keeps the prompt it started with.")}</p></div></aside></div>`;
}

function connectionsPage() {
  const configured = name => `<span data-secret="${name}" class="secret-state ${secretNames.has(name)||demo?'set':''}">${demo?t("Demo"):!secretsLoaded?t("Not checked"):secretNames.has(name)?t("Configured"):t("Not configured")}</span>`;
  return `<div class="settings-layout"><form id="settings-form" class="settings-form"><section class="panel"><div class="section-title"><div class="settings-title"><span class="service-symbol facebook-symbol">f</span><div><h2>Facebook</h2><p>${e(t("The page you’re sharing with."))}</p></div></div>${configured('FB_PAGE_ACCESS_TOKEN')}</div><label for="fb-token">${e(t("Page access token"))}</label><input id="fb-token" type="password" name="FB_PAGE_ACCESS_TOKEN" placeholder="${e(t("Paste a new page access token"))}" autocomplete="new-password" /><p class="field-hint">${e(t("Needs pages_manage_posts and pages_read_engagement permission."))}</p><label for="fb-page">${e(t("Facebook page ID"))} <span>${e(t("Optional update"))}</span></label><input id="fb-page" name="FB_PAGE_ID" placeholder="168846083148109" inputmode="numeric" autocomplete="off" /></section>
    <section class="panel"><div class="section-title"><div class="settings-title"><span class="service-symbol openai-symbol">${icon('spark')}</span><div><h2>OpenAI</h2><p>${e(t("A little help finding the right words."))}</p></div></div>${configured('OPENAI_API_KEY')}</div><label for="openai-key">${e(t("API key"))}</label><input id="openai-key" type="password" name="OPENAI_API_KEY" placeholder="${e(t("Paste a new OpenAI API key"))}" autocomplete="new-password" /><p class="field-hint">${e(t("Used to generate Hebrew captions. API usage is billed to your OpenAI account."))}</p><label for="openai-model">${e(t("Caption model"))} <span>${e(t("Optional update · all formats"))}</span></label><input id="openai-model" name="MODEL" placeholder="gpt-4.1-mini" autocomplete="off" /></section>
    <section class="panel"><div class="section-title"><div class="settings-title"><span class="service-symbol google-symbol">${icon('image')}</span><div><h2>Google Drive & Forms</h2><p>${e(t("Your library of photos, videos, and questions."))}</p></div></div>${configured('GOOGLE_SERVICE_ACCOUNT_JSON')}</div><details><summary>${e(t("Update content sources"))} ${icon('chevron')}</summary><label for="google-key">${e(t("Service account JSON"))}</label><textarea id="google-key" name="GOOGLE_SERVICE_ACCOUNT_JSON" class="credential-textarea" placeholder="${e(t("Paste the new service account JSON"))}" spellcheck="false" autocomplete="off"></textarea><p class="field-hint">${e(t("Share each media folder and question form with the service account email."))}</p>${[['DRIVE_FOLDER_ID',t("Photo folder ID")],['DRIVE_FOLDER_ID_VIDEO',t("Video folder ID")],['DRIVE_FOLDER_ID_QUESTIONS',t("Question forms folder ID")]].map(([name,label])=>`<label for="${name}">${label}</label><input id="${name}" name="${name}" placeholder="${e(t("Leave empty to keep the current folder"))}" autocomplete="off" />`).join('')}</details></section>
    <div id="settings-error" class="form-error" role="alert">${e(t(sourceMessage(secretsError)))}</div><div class="settings-save"><span>${icon('lock')} ${e(t("Blank fields keep existing values."))}</span><button type="submit" class="btn primary">${icon('check')} ${e(t("Save credentials"))}</button></div></form>
    <aside class="settings-aside"><div class="panel security-note"><span class="lock-tile">${icon('lock')}</span><h3>${e(t("Private by design."))}</h3><p>${e(t("Credentials are encrypted in your browser and saved in your private repository’s GitHub Secrets."))}</p><p>${e(t("They’re never saved in this website or returned to the browser. To change a key, simply enter a replacement."))}</p><div class="soft-note">${icon('check')} ${e(t("No database. No extra account."))}</div></div><div class="panel connection-panel"><span class="eyebrow">${e(t("YOUR CONNECTION"))}</span><h3>${icon('github')} GitHub Actions</h3><p class="repo-name">${e(demo?t("Demo workspace"):github.repoName())}</p><span class="connection-inline"><i></i>${demo?t("Sample data only"):t("Password session active")}</span><button class="btn secondary" data-action="logout">${icon('lock')} ${e(t("Lock studio"))}</button></div><div class="plain-note">${icon('info')} ${e(t("Saving credentials affects future runs. A workflow already in progress keeps its current keys."))}</div></aside></div>`;
}

const displayState = () => JSON.stringify([state, activityItems(state).map(item=>[item.id,item.status])]);
function changeLanguage(value) {
  // Rebuild translated labels while retaining every in-progress field and its
  // saved baseline. Files remain in selectedUpload and are restored by render().
  const fields = [...root.querySelectorAll('input[id], textarea[id], select[id]')]
    .filter(input => input.type !== 'file' && !input.hasAttribute('data-language'))
    .map(input => ({id:input.id, value:input.value, defaultValue:input.defaultValue,
      checked:input.checked, type:input.type, start:input.selectionStart, end:input.selectionEnd}));
  const details = [...root.querySelectorAll('details')].map(el=>el.open);
  const scroll = window.scrollY;
  setLocale(value);
  render();
  for (const saved of fields) {
    const input = document.getElementById(saved.id);
    if (!input) continue;
    if ('defaultValue' in input) input.defaultValue = saved.defaultValue;
    if (input.tagName === 'INPUT' && ['password','text'].includes(saved.type)) input.type = saved.type;
    input.value = saved.value;
    input.checked = saved.checked;
    if (saved.start !== null && input.setSelectionRange) input.setSelectionRange(saved.start, saved.end);
  }
  root.querySelectorAll('details').forEach((el,i)=>el.open=details[i]??false);
  root.querySelectorAll('.secret-toggle').forEach(button=> {
    const input=document.getElementById(button.dataset.target);
    const shown=input.type==='text';
    button.textContent=t(shown?'Hide':'Show');
    button.setAttribute('aria-pressed',String(shown));
    button.setAttribute('aria-label',t(shown?'Hide {label} replacement':'Show {label} replacement',{label:input.labels[0].textContent.toLowerCase()}));
  });
  document.querySelector('[data-language]')?.focus({preventScroll:true});
  window.scrollTo(0,scroll);
}

function render() {
  applyLocale();
  signedIn ? shell() : login();
  setMobileNav(mobileNav, false);
  const input=document.querySelector('#media-upload');
  if(input&&selectedUpload) {
    const transfer=new DataTransfer();transfer.items.add(selectedUpload.file);input.files=transfer.files;
  }
  renderedState = signedIn ? displayState() : '';
}
function lockStudio() {
  setMobileNav(false, false);
  uploading?.controller.abort();uploading=null;
  for(const url of uploadedMedia.values()) URL.revokeObjectURL(url);
  uploadedMedia.clear();clearUpload();uploadDescription='';uploadError='';sourceMode='library';
  closeModal();github.disconnect();demo=false;signedIn=false;pending=null;
  state={drafts:[],schedules:[],operations:[]};edits.clear();editRevisions.clear();
  editorSnapshot=null;secretNames.clear();secretsLoaded=false;secretsError='';selectedDraft=null;
  promptEdits.clear();promptSnapshot=null;promptType='image';settingsView='connections';render();window.scrollTo(0,0);
}
window.addEventListener('studio-locked', lockStudio);
function navigate(page) { setMobileNav(false, false); if(location.hash===`#${page}`) {render();window.scrollTo(0,0);}else location.hash=page; }

function setMobileNav(open, moveFocus = true) {
  mobileNav = Boolean(open && mobileViewport.matches && signedIn);
  document.documentElement.classList.toggle('mobile-nav-open', mobileNav);
  document.querySelector('.app-layout')?.classList.toggle('nav-open', mobileNav);
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.querySelector('.mobile-menu');
  toggle?.setAttribute('aria-expanded', String(mobileNav));
  if (sidebar) sidebar.inert = mobileViewport.matches && !mobileNav;
  document.querySelectorAll('.workspace > main, .demo-banner, .workspace-footer').forEach(el => el.inert = mobileNav);
  if (moveFocus) {
    if (mobileNav) (sidebar?.querySelector('.nav-link.active') || sidebar?.querySelector('.nav-link'))?.focus();
    else if (mobileViewport.matches) toggle?.focus({preventScroll:true});
  }
}

mobileViewport.addEventListener('change', () => setMobileNav(false, false));
document.addEventListener('keydown', event => {
  if (!mobileNav) return;
  if (event.key === 'Escape') {event.preventDefault();setMobileNav(false);}
  if (event.key === 'Tab') {
    const controls = [document.querySelector('.mobile-menu'), ...document.querySelectorAll('.sidebar a[href], .sidebar button:not(:disabled)')];
    const index = controls.indexOf(document.activeElement);
    event.preventDefault();
    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
  }
});

async function sync() {
  if (demo || !signedIn || polling) return;
  polling=true;
  try {
    state=await github.readState();
    if (pending) {
      const op=state.operations.find(x=>x.id===pending.id);
      if (op?.status === 'running') {pending.phase='running';updatePending();}
      if (op && ['complete','failed'].includes(op.status)) {
        const old=pending; pending=null;
        if(op.status==='failed') toast(op.error,true);
        else {
          if(old.promptType)promptEdits.delete(old.promptType);
          if(op.result && state.drafts.some(d=>d.id===op.result)) {
            selectedDraft=op.result;selectedType=currentDraft().type;edits.delete(op.result);editRevisions.delete(op.result);
            if(old.openResult) location.hash='create';
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
  if(pending||uploading) return toast(t("Let the current request finish first."));
  const id=crypto.randomUUID();
  pending={id,label:sourceMessage(label),success:sourceMessage(success),started:Date.now(),phase:'sending',promptType:payload.action==='save_prompt'?payload.type:null,openResult:payload.action==='recover_missed'}; render();
  try {
    if(demo) {
      await new Promise(resolve=>setTimeout(resolve,450));
      if(!signedIn||!demo||pending?.id!==id)return;
      const result=demoCommand(state,{...payload,id});
      if(result && state.drafts.some(d=>d.id===result)) {selectedDraft=result;selectedType=currentDraft().type;edits.delete(result);editRevisions.delete(result);}
      if(payload.action==='recover_missed' && result) location.hash='create';
      if(payload.action==='save_prompt')promptEdits.delete(payload.type);
      pending=null;render();toast(t('{message} (demo only)',{message:t(sourceMessage(success))}));
    } else {
      await github.dispatch({...payload,id});
      if(!signedIn || pending?.id !== id)return;
      if(pending.phase==='sending')pending.phase='queued';
      updatePending();
      await sync();
    }
  } catch(error) {pending=null;render();toast(error.message,true);}
}

function clearUpload() {
  if(selectedUpload&&!uploadedMedia.has(selectedUpload.id))URL.revokeObjectURL(selectedUpload.url);
  selectedUpload=null;
}

function selectUpload(file) {
  if(pending||uploading||!file)return;
  try {
    const details=fileDetails(file);
    clearUpload();
    selectedUpload={id:crypto.randomUUID(),file,details,url:URL.createObjectURL(file),manifest:null};
    selectedDraft=null;selectedType=details.type;uploadError='';render();
  } catch(error) {clearUpload();uploadError=error.message;render();}
}

async function generateUpload() {
  if(pending||uploading)return;
  const selection=selectedUpload;
  const description=uploadDescription.trim();
  if(!selection||!description||description.length>2000) {
    uploadError=t("Choose an image or video and describe it in a few words.");render();return;
  }
  const job={controller:new AbortController(),progress:0};
  uploading=job;uploadError='';render();
  try {
    if(!selection.manifest) selection.manifest=demo?{id:selection.id,...selection.details}:await uploadFile(selection.file,selection.id,progress=>{
      job.progress=progress;
      if(uploading===job&&document.querySelector('#upload-progress'))document.querySelector('#upload-progress').textContent=t('Saving your upload… {progress}%',{progress:number(progress)});
    },job.controller.signal);
    if(uploading!==job||!signedIn)return;
    uploadedMedia.set(selection.id,selection.url);
    uploading=null;
    await command({action:'generate_upload',type:selection.details.type,upload_id:selection.id,description,
      ...(demo?{demo_upload:selection.manifest}:{})},t("Writing your caption…"),t("Your uploaded post is ready to review"));
  } catch(error) {
    if(uploading!==job)return;
    uploading=null;uploadError=error.name==='AbortError'?t("Upload cancelled. You can try again."):error.message;render();
  }
}

async function watchUpload(draft) {
  const show=url=>modal(t("Your uploaded video"),t("Review the original video attached to this post."),`<video class="uploaded-player" src="${e(url)}" controls playsinline preload="metadata"></video><a class="text-link" href="${e(url)}" download="${e(draft.source.name)}">${e(t("Download video if playback is unavailable"))}</a>`);
  const cached=uploadedMedia.get(draft.source.upload_id);
  if(cached){show(cached);return;}
  modal(t("Your uploaded video"),t("Loading your private video…"),`<p role="status">${e(t("Downloading the saved video for playback."))}</p>`);
  const request=new AbortController();mediaRequest=request;
  try {
    const blob=await downloadUpload(draft.source,request.signal);
    if(mediaRequest!==request||!signedIn)return;
    const url=URL.createObjectURL(blob);uploadedMedia.set(draft.source.upload_id,url);show(url);
  } catch(error) {
    if(mediaRequest===request&&signedIn)modal(t("Video unavailable"),e(error.message),'');
  }
}

function draftCommand(action,extra={}) {
  const d=currentDraft();
  const snapshot=editorSnapshot?.id===d.id?editorSnapshot:{revision:d.revision,text:draftText(d)};
  return {action,draft_id:d.id,revision:snapshot.revision,text:snapshot.text,...extra};
}

function modal(title,description,body) {
  closeModal();
  document.querySelector('#modal-root').innerHTML=`<dialog id="studio-dialog"><div class="modal-heading"><div><h2>${title}</h2><p>${description}</p></div><button class="icon-btn" data-action="close-modal" aria-label="${e(t("Close dialog"))}">${icon('close')}</button></div>${body}</dialog>`;
  document.querySelector('#studio-dialog').showModal();
  document.querySelector('#studio-dialog').addEventListener('cancel',event=>{event.preventDefault();closeModal();});
}
function closeModal() { mediaRequest?.abort();mediaRequest=null;document.querySelector('#studio-dialog')?.close();document.querySelector('#modal-root').innerHTML=''; }

function scheduleModal(id) {
  const schedule=state.schedules.find(s=>s.id===id) || {name:'',type:'image',time:'09:00',timezone:'Asia/Jerusalem',mode:'draft',days:[0,1,2,3,4],enabled:true};
  modal(id?t("Edit your rhythm"):t("Make consistency simple"),t("A recurring time for your next great post."),`<form id="schedule-form" data-id="${e(id||'')}"><label for="schedule-name">${e(t("Schedule name"))}</label><input id="schedule-name" name="name" dir="auto" value="${e(schedule.name)}" placeholder="${e(t("e.g. Morning driving tips"))}" maxlength="100" required /><div class="form-grid"><div><label for="schedule-type">${e(t("Post format"))}</label><select id="schedule-type" name="type">${Object.keys(typeNames).map(type=>`<option value="${type}" ${schedule.type===type?'selected':''}>${typeNames[type]}</option>`).join('')}</select></div><div><label for="schedule-time">${e(t("Preferred time"))}</label><input id="schedule-time" type="time" name="time" value="${e(schedule.time)}" required /></div></div><label>${e(t("Repeat on"))}</label><div class="day-picker">${dayNames().map((day,i)=>`<label><input type="checkbox" name="days" value="${i}" ${schedule.days.includes(i)?'checked':''}/><span>${day}</span></label>`).join('')}</div><label for="schedule-zone">${e(t("Timezone"))}</label><input id="schedule-zone" name="timezone" value="${e(schedule.timezone)}" list="timezones" required /><datalist id="timezones"><option value="Asia/Jerusalem"><option value="Europe/London"><option value="America/New_York"><option value="UTC"></datalist><label for="schedule-mode">${e(t("When it’s time"))}</label><select id="schedule-mode" name="mode"><option value="draft" ${schedule.mode==='draft'?'selected':''}>${e(t("Prepare a draft for me to review"))}</option><option value="publish" ${schedule.mode==='publish'?'selected':''}>${e(t("Generate and publish automatically"))}</option></select><p class="field-hint" id="mode-hint">${schedule.mode==='publish'?t("This schedule publishes to Facebook without a manual review."):t("The post will wait in your drafts until you choose to publish.")}</p><div id="schedule-error" class="form-error" role="alert"></div><div class="modal-actions">${id?`<button type="button" class="icon-btn danger" data-action="delete-schedule" data-id="${e(id)}" aria-label="${e(t("Delete schedule"))}">${icon('trash')}</button>`:''}<button type="button" class="btn secondary" data-action="close-modal">${e(t("Cancel"))}</button><button type="submit" class="btn primary">${icon('check')} ${e(t("Save schedule"))}</button></div></form>`);
}

document.addEventListener('submit', async event=> {
  const form=event.target;
  if (!['login-form','schedule-form','one-time-form','settings-form','prompt-form','upload-form'].includes(form.id)) return;
  event.preventDefault();
  const data=new FormData(form);
  if(form.id==='upload-form') {await generateUpload();return;}
  if(form.id==='login-form') {
    const submit=form.querySelector('[type=submit]');submit.disabled=true;submit.textContent=t("Opening your studio…");
    try {
      await github.connect(config.gateway,String(data.get('password')));
      state=await github.readState();signedIn=true;demo=false;form.reset();
      render();if(route()==='settings')loadSecrets();
    } catch(error) { signedIn=false;github.disconnect();login(error.message); }
  }
  if(form.id==='prompt-form') {
    if(!promptSnapshot || pending)return;
    const value=promptSnapshot.text.trim();
    if(!value||value.length>8000)return toast(t("Enter a prompt of 1–8,000 characters."),true);
    await command({action:'save_prompt',type:promptSnapshot.type,prompt:value,revision:promptSnapshot.revision},t("Saving your prompt…"),t("Prompt saved. New posts will use these instructions."));
  }
  if(form.id==='schedule-form') {
    try {
      const days=data.getAll('days').map(Number);
      if(!days.length) throw new Error(t("Choose at least one day."));
      new Intl.DateTimeFormat('en',{timeZone:data.get('timezone')}).format();
      const schedule={name:data.get('name').trim(),type:data.get('type'),time:data.get('time'),timezone:data.get('timezone'),mode:data.get('mode'),days,enabled:state.schedules.find(s=>s.id===form.dataset.id)?.enabled??true};
      const id=form.dataset.id;closeModal();
      await command({action:'save_schedule',schedule,schedule_id:id||undefined},t("Saving your schedule…"),t("Schedule saved"));
    } catch(error) {const target=document.querySelector('#schedule-error');if(target) target.textContent=t(sourceMessage(error.message));else toast(error.message,true);}
  }
  if(form.id==='one-time-form') {
    try {
      const scheduled=inZone(data.get('date'),'Asia/Jerusalem');
      if(scheduled<=new Date()) throw new Error(t("Choose a time in the future."));
      closeModal();await command(draftCommand('schedule_draft',{scheduled_at:scheduled.toISOString()}),t("Scheduling your post…"),t("Post scheduled"));
    } catch(error) {const target=document.querySelector('#one-time-error');if(target)target.textContent=t(sourceMessage(error.message));else toast(error.message,true);}
  }
  if(form.id==='settings-form') {
    const submit=form.querySelector('[type=submit]');
    try {
      const values=Object.fromEntries([...data.entries()].map(([k,v])=>[k,v.trim()]).filter(([,v])=>v));
      if(!Object.keys(values).length) throw new Error(t("Enter at least one new value to save."));
      if(values.GOOGLE_SERVICE_ACCOUNT_JSON) {const parsed=JSON.parse(values.GOOGLE_SERVICE_ACCOUNT_JSON);if(!parsed.private_key||!parsed.client_email||parsed.type!=='service_account')throw new Error(t("Enter a valid Google service account JSON file."));}
      if(values.FB_PAGE_ID&&!/^\d+$/.test(values.FB_PAGE_ID)) throw new Error(t("The Facebook page ID should contain only numbers."));
      if(values.MODEL) {for(const field of ['OPENAI_MODEL','OPENAI_MODEL_VIDEO','OPENAI_MODEL_QUESTION'])values[field]=values.MODEL;delete values.MODEL;}
      submit.disabled=true;submit.textContent=t("Saving securely…");document.querySelector('[data-language]').disabled=true;
      if(!demo) await github.saveSecrets(values);
      Object.keys(values).forEach(k=>secretNames.add(k));secretsLoaded=true;secretsError='';form.reset();render();toast(demo?t("Credentials simulated. Nothing was saved."):t("Credentials saved securely in GitHub Secrets"));
    } catch(error) {const target=document.querySelector('#settings-error');if(target)target.textContent=t(sourceMessage(error.message));else toast(error.message,true);submit.disabled=false;submit.innerHTML=icon('check')+(" "+t("Save credentials"));document.querySelector('[data-language]').disabled=false;}
  }
});

document.addEventListener('invalid',event=> {
  if(event.target.setCustomValidity) event.target.setCustomValidity(t(event.target.validity.valueMissing?'Please fill out this field.':'Check this value and try again.'));
},true);

document.addEventListener('input',event=> {
  event.target.setCustomValidity?.('');
  if(event.target.id==='upload-description') {
    uploadDescription=event.target.value;
    document.querySelector('#upload-form [type=submit]').disabled=Boolean(pending||uploading||!selectedUpload||!uploadDescription.trim());
  }
  if(event.target.id==='prompt-text'&&promptSnapshot&&!pending) {
    promptSnapshot.text=event.target.value;
    promptEdits.set(promptType,{text:promptSnapshot.text,revision:promptSnapshot.revision});
    document.querySelector('#prompt-count').textContent=t('{count} / {limit} characters',{count:number(promptSnapshot.text.length),limit:number(8000)});
    document.querySelector('#prompt-state').textContent=t("Unsaved changes");
    document.querySelector('#prompt-form [type=submit]').disabled=!promptSnapshot.text.trim();
    document.querySelector('[data-action="discard-prompt"]').disabled=false;
    document.querySelector('#prompt-preview').disabled=true;
  }
  if(event.target.id==='caption'&&currentDraft()) {
    if(!editRevisions.has(selectedDraft))editRevisions.set(selectedDraft,editorSnapshot.revision);
    edits.set(selectedDraft,event.target.value);editorSnapshot.text=event.target.value;
    document.querySelector('#preview-caption').textContent=event.target.value;
    document.querySelector('#caption-count').textContent=t('{count} characters',{count:number(event.target.value.length)});
    document.querySelector('#edit-state').textContent=t("Unsaved changes");
  }
});
document.addEventListener('change',event=> {
  if(event.target.hasAttribute('data-language')) {changeLanguage(event.target.value);return;}
  if(event.target.id==='media-upload')selectUpload(event.target.files[0]);
  if(event.target.id==='draft-select') {selectedDraft=event.target.value;selectedType=currentDraft()?.type||selectedType;render();}
  if(event.target.id==='schedule-mode') document.querySelector('#mode-hint').textContent=event.target.value==='publish'?t("This schedule publishes to Facebook without a manual review."):t("The post will wait in your drafts until you choose to publish.");
});

for(const name of ['dragover','drop']) document.addEventListener(name,event=> {
  if(!event.target.closest('.upload-dropzone'))return;
  event.preventDefault();
  if(name==='drop')selectUpload(event.dataTransfer.files[0]);
});

document.addEventListener('click',async event=> {
  const navLink=event.target.closest('.nav-link[href]');
  if(navLink&&mobileNav) setMobileNav(false);
  const button=event.target.closest('[data-action]');
  if(!button||button.disabled) return;
  const action=button.dataset.action;
  if(uploading&&!['logout','menu','close-menu','cancel-upload'].includes(action))return;
  if(action==='cancel-upload') {uploading?.controller.abort();uploading=null;uploadError=t("Upload cancelled. You can try again.");render();}
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
  if(action==='menu') setMobileNav(!mobileNav);
  if(action==='close-menu') setMobileNav(false);
  if(action==='source-mode') {sourceMode=button.dataset.mode;uploadError='';render();}
  if(action==='remove-upload') {clearUpload();uploadError='';render();}
  if(action==='new') {sourceMode='library';selectedDraft=null;selectedType=button.dataset.type||'image';navigate('create');}
  if(action==='type') {selectedType=button.dataset.type;selectedDraft=null;render();}
  if(action==='open-draft') {selectedDraft=button.dataset.id;selectedType=currentDraft().type;navigate('create');}
  if(action==='generate') await command({action:'generate',type:selectedType},t("Creating your draft…"),t("Your draft is ready to review"));
  if(action==='revert-edits') {edits.delete(selectedDraft);editRevisions.delete(selectedDraft);render();}
  if(action==='save-draft') await command(draftCommand('save_draft'),t("Saving your draft…"),t("Draft saved"));
  if(action==='publish') {
    modal(t("Ready for your audience?"),demo?t("This is a demo. No post will be sent to Facebook."):t("This publishes the selected media and the caption shown in your preview to Alfred Kor’s Facebook page."),`<div class="publish-summary">${typeIcon(currentDraft().type)}<strong>${e(currentDraft().source.name)}</strong></div><div class="modal-actions"><button class="btn secondary" data-action="close-modal">${e(t("Keep editing"))}</button><button class="btn primary" data-action="confirm-publish">${icon('send')} ${demo?t("Simulate publishing"):t("Publish to Facebook")}</button></div>`);
  }
  if(action==='confirm-publish') {closeModal();await command(draftCommand('publish'),t("Publishing your post…"),t("Facebook accepted your post"));}
  if(action==='delete-draft') modal(t("Let this idea go?"),t("This deletes the draft and cancels its scheduled publication."),`<div class="modal-actions"><button class="btn secondary" data-action="close-modal">${e(t("Keep draft"))}</button><button class="btn danger-solid" data-action="confirm-delete-draft">${e(t("Delete draft"))}</button></div>`);
  if(action==='confirm-delete-draft') {closeModal();const payload=draftCommand('delete_draft');selectedDraft=null;await command(payload,t("Deleting your draft…"),t("Draft deleted"));}
  if(action==='schedule-draft') {
    const future=new Date(Date.now()+3600000);const p=zonedParts(future,'Asia/Jerusalem');
    modal(t("Give this post its moment."),t("Choose a time in Israel. Your post will publish at the next schedule check after that time."),`<form id="one-time-form"><label for="post-date">${e(t("Date & time · Asia/Jerusalem"))}</label><input id="post-date" name="date" type="datetime-local" value="${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}" required /><div id="one-time-error" class="form-error" role="alert"></div><div class="modal-actions"><button class="btn secondary" type="button" data-action="close-modal">${e(t("Cancel"))}</button><button class="btn primary" type="submit">${icon('calendar')} ${e(t("Schedule post"))}</button></div></form>`);
  }
  if(action==='cancel-draft') await command(draftCommand('cancel_draft'),t("Updating your draft…"),t("Post moved back to drafts"));
  if(action==='run-due') {
    if(!demo){await sync();if(!signedIn)return;}
    const tasks=dueTasks(state);
    modal(t("Run due tasks now?"),demo?t("This is a demo. No post will be sent to Facebook."):t("Due posts set to publish will be sent to Facebook. Draft-only tasks will prepare a draft for review."),
      `${tasks.length?`<div class="run-due-list">${tasks.map(task=>`<div class="run-due-item">${typeIcon(task.type)}<div><strong>${e(task.name)}</strong><span>${e(formatDate(task.date))} · ${task.mode==='draft'?t("Prepare a draft"):task.kind==='draft'?t("Publish saved post"):t("Generate and publish")}</span></div></div>`).join('')}</div>`:`<p class="field-hint">${e(t("No tasks are currently due. You can still request a fresh check."))}</p>`}<p class="field-hint">${e(t("The check uses your saved schedules when it starts. Paused, future, and expired recurring tasks are not forced to run. GitHub may take a few minutes to start and finish the check."))}</p><div class="modal-actions"><button class="btn secondary" data-action="close-modal">${e(t("Cancel"))}</button><button class="btn primary" data-action="confirm-run-due">${icon('send')} ${demo?t("Simulate due tasks"):t("Run due tasks")}</button></div>`);
  }
  if(action==='confirm-run-due') {closeModal();await command({action:'run_due'},t("Running due tasks…"),t("Schedule check finished. Review the results in Schedule and Activity."));}
  if(action==='recover-missed') {
    await command({action:'recover_missed',missed_id:button.dataset.id||undefined,schedule_id:button.dataset.scheduleId,slot:button.dataset.slot},t("Preparing the missed draft…"),t("The missed run is ready to review."));
  }
  if(action==='new-schedule') scheduleModal();
  if(action==='edit-schedule') scheduleModal(button.dataset.id);
  if(action==='toggle-schedule') {const s=state.schedules.find(s=>s.id===button.dataset.id);await command({action:'toggle_schedule',schedule_id:s.id,enabled:!s.enabled},t("Updating your schedule…"),s.enabled?t("Schedule paused"):t("Schedule resumed"));}
  if(action==='delete-schedule') {const id=button.dataset.id;modal(t("Remove this schedule?"),t("Future recurring runs will stop. Drafts already created will stay in your workspace."),`<div class="modal-actions"><button class="btn secondary" data-action="close-modal">${e(t("Keep schedule"))}</button><button class="btn danger-solid" data-action="confirm-delete-schedule" data-id="${e(id)}">${e(t("Delete schedule"))}</button></div>`);}
  if(action==='confirm-delete-schedule') {const id=button.dataset.id;closeModal();await command({action:'delete_schedule',schedule_id:id},t("Removing your schedule…"),t("Schedule removed"));}
  if(action==='close-modal') closeModal();
  if(action==='filter') {activityFilter=button.dataset.filter;render();}
  if(action==='refresh') {if(!demo){await sync();render();if(!signedIn)return;}await command({action:'refresh'},t("Checking publication status…"),t("Publication status refreshed"));}
  if(action==='watch-video') {
    const draft=state.drafts.find(d=>d.id===button.dataset.id)||currentDraft();
    if(draft?.source.upload_id){await watchUpload(draft);return;}
    const id=draft?.source.id;
    if(/^[\w-]+$/.test(id)) modal(t("Your selected video"),t("Playback uses your Google Drive access."),`<iframe class="drive-player" src="https://drive.google.com/file/d/${e(id)}/preview" title="${e(t("Selected video from Google Drive"))}" allow="fullscreen" referrerpolicy="no-referrer"></iframe>`);
  }
});

window.addEventListener('hashchange',()=> {setMobileNav(false,false);render();window.scrollTo(0,0);if(route()==='settings'&&signedIn&&!demo&&!secretsLoaded)loadSecrets();});
async function loadSecrets() {
  try {secretNames=await github.secretsStatus();secretsLoaded=true;}catch(error){secretsError=error.message;}
  if(signedIn&&route()==='settings'&&settingsView==='connections') {
    document.querySelectorAll('[data-secret]').forEach(el=> {
      const exists=secretNames.has(el.dataset.secret);el.textContent=exists?t("Configured"):t("Not configured");el.classList.toggle('set',exists);
    });
    document.querySelector('#settings-error').textContent=t(sourceMessage(secretsError));
  }
}
setInterval(sync,8000);
setInterval(updatePending,1000);
try {config=await fetch('./config.json',{cache:'no-store'}).then(r=>r.json());}catch{/* login reports a missing connection configuration */}
render();
