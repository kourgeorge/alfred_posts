import { dueTasks, inZone } from './utils.js';

const styleOpenings = {
  neutral: 'נהיגה בטוחה מבוססת על תשומת לב ועל תרגול הרגלים נכונים.',
  funny: 'המכונית עוד לא יודעת לקרוא מחשבות — מזל שיש לנו איתות 😉',
  friendly: 'בואו ניקח רגע לדבר על ההרגלים הקטנים שעוזרים לנו בדרך 🙂',
  professional: 'הכנה נכונה ותרגול עקבי הם מרכיבים חשובים בלימוד נהיגה אחראית.',
  educational: 'טיפ ללמידה: נסו להסביר במילים שלכם את ההיגיון מאחורי כל כלל שאתם לומדים.',
  motivational: 'כל תרגול הוא עוד הזדמנות ללמוד. מתקדמים בקצב שלכם, צעד אחר צעד 💪',
  storytelling: 'דמיינו שאתם מתיישבים ברכב לקראת שיעור נהיגה. רגע לפני שמתחילים, יש זמן לעצור, לנשום ולהתכונן לדרך.',
  promotional: 'רוצים להתכונן לתיאוריה בקצב שלכם? הצטרפו לקורס האונליין ונלמד יחד את הדרך 🚗',
};

function styledSample(text, style) {
  return Object.hasOwn(styleOpenings, style) ? [styleOpenings[style], ...text.split('\n\n').slice(1)].join('\n\n') : text;
}

export function demoState() {
  const ago = days => new Date(Date.now() - days * 86400000).toISOString();
  const photo = { id: 'demo-photo', type: 'image', status: 'draft', revision: 1, created_at: ago(0),
    source: { key: 'demo-photo', name: 'A safer journey starts with good habits', url: null }, preview: './road.svg',
    text: 'נהיגה בטוחה מתחילה הרבה לפני שמניעים את הרכב. 🚗\n\nכוונו את המראות, בדקו שכולם חגורים וקחו רגע להתמקד בדרך. הרגל קטן בתחילת הנסיעה יכול לעשות הבדל גדול.\n\nאיזה הרגל עוזר לכם לצאת לדרך בביטחון? כתבו לי בתגובות.\n\n📚 מתכוננים לתיאוריה? לומדים יחד, בקצב שלכם:\nhttps://test4u.teachable.com/\nwww.test4u.co.il' };
  const video = { ...photo, id: 'demo-video', type: 'video', preview: null,
    source: { key: 'demo-video', name: 'Theory, one step at a time', url: null },
    text: 'לא רק לשנן תשובות — להבין את הדרך. 🚦\n\nכשפותרים שאלה בתיאוריה, כדאי לשאול גם למה התשובה נכונה. ההבנה הזאת ממשיכה איתכם לשיעורי הנהיגה.\n\nאיזה נושא בתיאוריה הייתם רוצים שאסביר בסרטון הבא?\nhttps://test4u.teachable.com/\nwww.test4u.co.il' };
  const question = { ...photo, id: 'demo-question', type: 'question',
    source: { key: 'demo-question', name: 'Before you set off', url: null },
    text: 'שאלת חימום לדרך 🚦\n\nמתי כדאי לכוון את המראות?\n1. לפני תחילת הנסיעה\n2. בזמן הנסיעה\n3. רק כשהראות מוגבלת\n\nכתבו את התשובה שלכם בתגובות.\nלומדים לתיאוריה יחד: https://test4u.teachable.com/' };
  return { version: 1, drafts: [photo, video, question, { ...photo, id: 'demo-published', status: 'published',
    published_at: ago(1), source: {...photo.source, name: 'Small habits. Safer roads.'} }],
    schedules: [
      { id: 'demo-s1', name: 'Morning driving tips', type: 'image', mode: 'draft', days: [0, 2, 4], time: '09:00', timezone: 'Asia/Jerusalem', enabled: true, starts_at: ago(0) },
      { id: 'demo-s2', name: 'The theory challenge', type: 'question', mode: 'publish', days: [1, 3, 6], time: '18:00', timezone: 'Asia/Jerusalem', enabled: true, starts_at: ago(0) },
      { id: 'demo-s3', name: 'A lesson for the weekend', type: 'video', mode: 'draft', days: [4], time: '10:30', timezone: 'Asia/Jerusalem', enabled: false },
    ], operations: [], connection_settings: {updated_at:ago(0), values:{FB_PAGE_ID:'1234567890',
      DRIVE_FOLDER_ID:'demo-photo-folder',DRIVE_FOLDER_ID_VIDEO:'demo-video-folder',DRIVE_FOLDER_ID_QUESTIONS:'demo-question-folder',
      OPENAI_MODEL:'gpt-4.1-mini',OPENAI_MODEL_VIDEO:'gpt-4.1-mini',OPENAI_MODEL_QUESTION:'gpt-4.1-mini'}},
    posted: { image: ['sample'], video: [], question: [] } };
}

export function demoCommand(state, command) {
  const draft = state.drafts.find(d => d.id === command.draft_id);
  let result;
  switch (command.action) {
    case 'refresh_models':
      state.model_catalog={ids:['gpt-4.1-mini','gpt-4.1','gpt-5-mini'],refreshed_at:new Date().toISOString()};
      break;
    case 'save_model':
      if(command.revision!==(state.ai_settings?.revision??0))throw new Error('The model changed in another session. Discard your change and choose again.');
      state.ai_settings={model:command.model,revision:command.revision+1};
      break;
    case 'generate_upload': {
      const upload=command.demo_upload;
      state.drafts.unshift({id:command.id,type:command.type,status:'draft',revision:1,created_at:new Date().toISOString(),caption_style:command.caption_style??'default',
        source:{key:`upload:${command.upload_id}`,upload_id:command.upload_id,name:upload.name,mime:upload.mime,
          size:upload.size,parts:upload.parts,description:command.description},preview:null,
        text:`${command.description}\n\n${Object.hasOwn(styleOpenings,command.caption_style)?styleOpenings[command.caption_style]:'צעד קטן בדרך לנהיגה בטוחה יותר. 🚗'}\nמה אתם חושבים? שתפו בתגובות.\n\nhttps://test4u.teachable.com/\nwww.test4u.co.il`});
      result=command.id;break;
    }
    case 'recover_missed': {
      state.missed_runs ??= [];
      let missed=state.missed_runs.find(r=>command.missed_id?r.id===command.missed_id:r.schedule_id===command.schedule_id&&r.slot===command.slot);
      if(!missed) {
        const schedule=state.schedules.find(s=>s.id===command.schedule_id);
        if(!schedule)throw new Error('This missed run is not available.');
        missed={id:`demo-missed-${schedule.id}-${command.slot}`,schedule_id:schedule.id,slot:command.slot,name:schedule.name,type:schedule.type,mode:schedule.mode,
          scheduled_at:inZone(command.slot.replace('@','T'),schedule.timezone).toISOString(),status:'missed'};
        state.missed_runs.push(missed);
      }
      const existing=state.drafts.find(d=>d.id===missed.draft_id);
      if(existing){result=existing.id;break;}
      const sample=demoState().drafts.find(d=>d.type===missed.type);
      result=`recovered-${missed.id}`;
      state.drafts.unshift({...sample,id:result,missed_run_id:missed.id,schedule_id:missed.schedule_id,created_at:new Date().toISOString(),status:'draft'});
      Object.assign(missed,{draft_id:result,status:'draft'});
      break;
    }
    case 'run_due': {
      const now = new Date().toISOString();
      for (const task of dueTasks(state)) {
        if (task.kind === 'draft') {
          const item = state.drafts.find(d => d.id === task.id);
          Object.assign(item, {status:'published', published_at:now, scheduled_at:null, revision:item.revision+1});
        } else {
          const schedule = state.schedules.find(s => s.id === task.id);
          const sample = demoState().drafts.find(d => d.type === task.type);
          const id = `demo-run-${schedule.id}-${task.slot}`;
          const status = task.mode === 'publish' ? 'published' : 'draft';
          state.drafts.unshift({...sample, id, schedule_id:schedule.id, created_at:now, status,
            ...(status === 'published' ? {published_at:now} : {})});
          Object.assign(schedule, {last_slot:task.slot, last_run:now, last_draft_id:id, last_status:status, last_error:null});
        }
      }
      state.scheduler = {last_started_at:now, last_finished_at:now};
      break;
    }
    case 'save_prompt': {
      state.prompts ??= {}; state.prompt_revisions ??= {};
      if (command.revision !== (state.prompt_revisions[command.type] ?? 0)) throw new Error('This prompt changed. Discard your changes before editing again.');
      state.prompts[command.type] = command.prompt.trim();
      state.prompt_revisions[command.type] = command.revision + 1;
      break;
    }
    case 'generate': {
      const sample = command.type==='news'?{
        type:'news',status:'draft',revision:1,preview:'./road.svg',
        source:{key:'demo-news',name:'דוגמה: תחבורה חכמה בדרך לעיר',url:'https://www.bbc.com/news/topics/cg41ylwvggnt',
          publisher:'bbc.com',region:'world',source_date:new Date().toISOString(),media_kind:'image'},
        text:'דוגמה בלבד: איך יכולה תחבורה חכמה לשנות את הדרך שלנו? 🚍\n\nזהו פוסט לדוגמה, ולא דיווח על אירוע אמיתי. במצב הרגיל אלפרד מחפש חדשות עדכניות, בוחר כתבה עם תמונה ומכין טקסט שמבוסס על המקור.\n\nמה הייתם רוצים לשפר בתחבורה באזור שלכם?\n\nhttps://www.bbc.com/news/topics/cg41ylwvggnt',
      }:demoState().drafts.find(d => d.type === command.type);
      state.drafts.unshift({...sample, id: command.id, created_at: new Date().toISOString(),
        caption_style:command.caption_style??'default',text:styledSample(sample.text,command.caption_style)});
      result = command.id; break;
    }
    case 'save_draft': case 'schedule_draft': case 'cancel_draft':
      Object.assign(draft, { text: command.text ?? draft.text, revision: draft.revision + 1,
        status: command.action === 'save_draft' ? draft.status : command.action === 'schedule_draft' ? 'scheduled' : 'draft',
        scheduled_at: command.action === 'save_draft' ? draft.scheduled_at : command.scheduled_at || null });
      result = draft.id; break;
    case 'publish':
      Object.assign(draft, {text: command.text ?? draft.text, status: 'published', published_at: new Date().toISOString(), revision: draft.revision + 1});
      result = draft.id; break;
    case 'delete_draft': draft.status = 'deleted'; break;
    case 'save_schedule': {
      const existing = state.schedules.find(s => s.id === command.schedule_id);
      if (existing) Object.assign(existing, command.schedule, {starts_at:new Date().toISOString()});
      else state.schedules.push({...command.schedule, id: command.id, starts_at:new Date().toISOString()});
      break;
    }
    case 'toggle_schedule': Object.assign(state.schedules.find(s => s.id === command.schedule_id), {enabled:command.enabled, starts_at:new Date().toISOString()}); break;
    case 'delete_schedule': state.schedules = state.schedules.filter(s => s.id !== command.schedule_id); break;
  }
  state.operations.unshift({ id: command.id, action: command.action, status: 'complete', result, created_at: new Date().toISOString() });
  return result;
}
