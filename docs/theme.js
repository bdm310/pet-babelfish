(function () {
  var KEY    = 'pb-theme';
  var THEMES = ['auto', 'light', 'dark'];
  var LABELS = { auto: 'auto', light: 'light', dark: 'dark' };

  function get() { return localStorage.getItem(KEY) || 'auto'; }

  function apply(t) {
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }

  function set(t) {
    if (t === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
    apply(t);
    sync();
  }

  function cycle() {
    set(THEMES[(THEMES.indexOf(get()) + 1) % THEMES.length]);
  }

  function sync() {
    var label = LABELS[get()];
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.textContent = label;
    });
  }

  window.themeToggle = { cycle: cycle };
  document.addEventListener('DOMContentLoaded', sync);
})();
