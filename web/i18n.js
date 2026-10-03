import { translations } from './translations.js';

export const languages = { en: 'English', he: 'עברית', ar: 'العربية' };
const preferenceKey = 'alfred-ui-language';
let current = 'en';
try {
  const saved = globalThis.localStorage?.getItem(preferenceKey);
  const browser = globalThis.navigator?.language?.split('-')[0];
  current = Object.hasOwn(languages, saved) ? saved : Object.hasOwn(languages, browser) ? browser : 'en';
} catch { /* The interface also works when browser storage is unavailable. */ }

export const locale = () => current;
export function setLocale(value) {
  if (!Object.hasOwn(languages, value)) return;
  current = value;
  try { globalThis.localStorage?.setItem(preferenceKey, value); } catch { /* Optional preference only. */ }
}

export function t(message, values = {}) {
  const text = current === 'en' ? message : translations[message]?.[current === 'he' ? 0 : 1] ?? message;
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}

// Pending operations keep a language-independent message while the UI changes.
export function sourceMessage(message) {
  if (Object.hasOwn(translations, message)) return message;
  return Object.keys(translations).find(key => translations[key].includes(message)) ?? message;
}

export const number = value => new Intl.NumberFormat(current).format(value);

export function applyLocale() {
  document.documentElement.lang = current;
  document.documentElement.dir = current === 'en' ? 'ltr' : 'rtl';
  document.title = t('Alfred Studio — Your publishing space');
}
