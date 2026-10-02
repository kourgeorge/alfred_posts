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
    published_at: ago(1), preview: null, source: {...photo.source, name: 'Small habits. Safer roads.'} }],
    schedules: [
      { id: 'demo-s1', name: 'Morning driving tips', type: 'image', mode: 'draft', days: [0, 2, 4], time: '09:00', timezone: 'Asia/Jerusalem', enabled: true },
      { id: 'demo-s2', name: 'The theory challenge', type: 'question', mode: 'publish', days: [1, 3, 6], time: '18:00', timezone: 'Asia/Jerusalem', enabled: true },
      { id: 'demo-s3', name: 'A lesson for the weekend', type: 'video', mode: 'draft', days: [4], time: '10:30', timezone: 'Asia/Jerusalem', enabled: false },
    ], operations: [], posted: { image: ['sample'], video: [], question: [] } };
}

export function demoCommand(state, command) {
  const draft = state.drafts.find(d => d.id === command.draft_id);
  let result;
  switch (command.action) {
    case 'generate': {
      const sample = demoState().drafts.find(d => d.type === command.type);
      state.drafts.unshift({...sample, id: command.id, created_at: new Date().toISOString()});
      result = command.id; break;
    }
    case 'save_draft': case 'schedule_draft': case 'cancel_draft':
      Object.assign(draft, { text: command.text ?? draft.text, revision: draft.revision + 1,
        status: command.action === 'schedule_draft' ? 'scheduled' : 'draft', scheduled_at: command.scheduled_at || null });
      result = draft.id; break;
    case 'publish':
      Object.assign(draft, {text: command.text ?? draft.text, status: 'published', published_at: new Date().toISOString(), revision: draft.revision + 1});
      result = draft.id; break;
    case 'delete_draft': draft.status = 'deleted'; break;
    case 'save_schedule': {
      const existing = state.schedules.find(s => s.id === command.schedule_id);
      if (existing) Object.assign(existing, command.schedule);
      else state.schedules.push({...command.schedule, id: command.id});
      break;
    }
    case 'toggle_schedule': state.schedules.find(s => s.id === command.schedule_id).enabled = command.enabled; break;
    case 'delete_schedule': state.schedules = state.schedules.filter(s => s.id !== command.schedule_id); break;
  }
  state.operations.unshift({ id: command.id, action: command.action, status: 'complete', result, created_at: new Date().toISOString() });
  return result;
}
