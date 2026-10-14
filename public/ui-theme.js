// Browser-only appearance. Loaded before CSS so a saved dark theme never flashes light.
(() => {
  'use strict';
  const key = 'pm.uiTheme';
  const themes = [
    ['sage', 'Sage', 'Soft greens, a familiar calm.'],
    ['sand', 'Sand', 'Warm paper and terracotta.'],
    ['ocean', 'Ocean', 'Cool blues, a clear head.'],
    ['midnight', 'Midnight', 'Quiet indigo for after hours.'],
    ['system', 'Follow system', 'Sage in light mode, Midnight in dark mode.'],
  ];
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = value => themes.some(([id]) => id === value) ? value : 'sage';
  let choice = 'sage';
  try { choice = normalize(JSON.parse(localStorage.getItem(key))); } catch {}

  function apply() {
    const resolved = choice === 'system' ? (system.matches ? 'midnight' : 'sage') : choice;
    const scheme = resolved === 'midnight' ? 'dark' : 'light';
    document.documentElement.dataset.uiTheme = resolved;
    document.documentElement.style.colorScheme = scheme;
    document.querySelector('meta[name="color-scheme"]').content = scheme;
    document.querySelector('meta[name="theme-color"]').content = {
      sage: '#f8f8f4', sand: '#faf5ef', ocean: '#f2f7fa', midnight: '#151824',
    }[resolved];
    document.querySelectorAll('[data-ui-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.uiThemeChoice === choice));
    });
  }
  apply();
  system.addEventListener('change', () => { if (choice === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    try { choice = normalize(JSON.parse(event.newValue)); } catch { choice = 'sage'; }
    apply();
  });

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-ui-theme-picker]').forEach(picker => {
      picker.innerHTML = themes.map(([id, name, description]) => `<button type="button" class="ui-theme-option" data-ui-theme-choice="${id}" aria-pressed="${choice === id}"><span class="ui-theme-preview" data-theme-preview="${id === 'system' ? 'sage' : id}" aria-hidden="true"><span class="ui-theme-preview-side"></span><span class="ui-theme-preview-content"><i></i><i></i><i></i></span>${id === 'system' ? '<span class="ui-theme-system">◐</span>' : ''}</span><span class="ui-theme-name">${name}<span class="ui-theme-check" aria-hidden="true">✓</span></span><span class="ui-theme-description">${description}</span></button>`).join('');
      picker.addEventListener('click', event => {
        const button = event.target.closest('[data-ui-theme-choice]');
        if (!button) return;
        choice = normalize(button.dataset.uiThemeChoice);
        try { localStorage.setItem(key, JSON.stringify(choice)); } catch {}
        apply();
      });
    });
    const dialog = document.querySelector('#uiThemeDialog');
    const trigger = document.querySelector('#uiThemeButton');
    trigger.addEventListener('click', () => { dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); });
    dialog.querySelectorAll('[data-close-theme]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => { trigger.setAttribute('aria-expanded', 'false'); trigger.focus({ preventScroll: true }); });
  });
})();
