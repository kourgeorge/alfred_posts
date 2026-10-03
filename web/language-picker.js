import { languages, locale, t } from './i18n.js';
import { icon } from './icons.js';
import { escape as e } from './utils.js';

export function languagePicker() {
  const current = locale();
  const label = t('Interface language');
  return `<div class="language-picker">
    <button type="button" id="ui-language" class="language-trigger" data-language value="${current}" aria-label="${e(label)}: ${languages[current]}" aria-haspopup="menu" aria-expanded="false" aria-controls="language-menu">
      ${icon('globe')}<span class="language-current" lang="${current}" dir="auto">${languages[current]}</span><span class="language-code" aria-hidden="true">${current.toUpperCase()}</span>${icon('chevron', 'language-chevron')}
    </button>
    <div id="language-menu" class="language-menu" role="menu" aria-label="${e(label)}" hidden>
      <p class="language-menu-label" aria-hidden="true">${e(label)}</p>
      ${Object.entries(languages).map(([code, name]) => `<button type="button" class="language-option" role="menuitemradio" aria-checked="${code === current}" data-language-choice="${code}" tabindex="-1"><span lang="${code}" dir="auto">${name}</span>${icon('check')}</button>`).join('')}
    </div>
  </div>`;
}

export function bindLanguagePicker(onChange, onOpen) {
  const picker = () => document.querySelector('.language-picker');
  function close(restoreFocus = false) {
    const root = picker();
    const menu = root?.querySelector('.language-menu');
    if (!menu || menu.hidden) return;
    const trigger = root.querySelector('[data-language]');
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus || menu.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    menu.hidden = true;
  }
  function open(edge) {
    const root = picker();
    const trigger = root?.querySelector('[data-language]');
    if (!trigger || trigger.disabled) return;
    onOpen?.();
    const menu = root.querySelector('.language-menu');
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const options = [...menu.querySelectorAll('[role="menuitemradio"]')];
    const selected = edge === 'first' ? options[0] : edge === 'last' ? options.at(-1) : options.find(option => option.getAttribute('aria-checked') === 'true');
    selected.focus({ preventScroll: true });
  }

  document.addEventListener('click', event => {
    const root = picker();
    if (!root?.contains(event.target)) return close();
    const trigger = root.querySelector('[data-language]');
    if (trigger.disabled) return;
    if (event.target.closest('[data-language]')) {
      if (trigger.getAttribute('aria-expanded') === 'true') close(true);
      else open();
    }
    const option = event.target.closest('[data-language-choice]');
    if (option) {
      close(true);
      if (option.dataset.languageChoice !== locale()) onChange(option.dataset.languageChoice);
    }
  });
  document.addEventListener('focusin', event => {
    if (!picker()?.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    const root = picker();
    if (!root?.contains(event.target)) return;
    const menu = root.querySelector('.language-menu');
    if (menu.hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        open(event.key === 'ArrowDown' ? 'first' : 'last');
      }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    const options = [...menu.querySelectorAll('[role="menuitemradio"]')];
    const index = options.indexOf(document.activeElement);
    const next = { ArrowDown: (index + 1) % options.length, ArrowUp: (index - 1 + options.length) % options.length, Home: 0, End: options.length - 1 }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      options[next].focus({ preventScroll: true });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const match = options.find(option => option.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      if (match) { event.preventDefault(); match.focus({ preventScroll: true }); }
    }
  });
}
