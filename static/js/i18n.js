// ═══════════════════════════════════════════════
// GOLDEX AI — SHARED ID/EN LANGUAGE TOGGLE
// ═══════════════════════════════════════════════
// Setiap halaman panggil initI18n(dict) dengan dictionary miliknya sendiri.
// Bahasa default: Indonesia ("id"). Pilihan tersimpan di localStorage,
// dipakai ulang di semua halaman (landing, login, dashboard, admin).

(function () {
  const STORAGE_KEY = "xau_lang";
  let currentDict = {};
  let currentLang = "id";

  function getSavedLang() {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "en" ? "en" : "id"; // default selalu "id"
  }

  // Ambil string terjemahan untuk dipakai di JS (konten yang dirender dinamis,
  // bukan lewat atribut data-i18n). Fallback ke key itu sendiri kalau tidak ada.
  function t(key) {
    const dict = currentDict[currentLang] || {};
    return dict[key] !== undefined ? dict[key] : key;
  }

  function applyLanguage(lang) {
    currentLang = lang;
    const dict = currentDict[lang] || {};
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const val = dict[key];
      if (val === undefined) return;

      const attr = el.getAttribute("data-i18n-attr");
      if (attr) {
        el.setAttribute(attr, val);
      } else if (el.hasAttribute("data-i18n-html")) {
        el.innerHTML = val;
      } else {
        el.textContent = val;
      }
    });

    document.documentElement.setAttribute("lang", lang);
    localStorage.setItem(STORAGE_KEY, lang);

    document.querySelectorAll(".lang-toggle-btn").forEach((btn) => {
      const isActive = btn.getAttribute("data-lang") === lang;
      btn.classList.toggle("active", isActive);
    });

    document.dispatchEvent(new CustomEvent("langchange", { detail: { lang } }));
  }

  function setLanguage(lang) {
    applyLanguage(lang === "en" ? "en" : "id");
  }

  function injectToggleStyles() {
    if (document.getElementById("lang-toggle-style")) return;
    const style = document.createElement("style");
    style.id = "lang-toggle-style";
    style.textContent = `
      .lang-toggle {
        display: inline-flex;
        align-items: center;
        background: var(--bg2, #161820);
        border: 1px solid var(--border2, #2e3245);
        border-radius: 999px;
        padding: 3px;
        gap: 2px;
        font-family: var(--mono, 'JetBrains Mono', monospace);
      }
      .lang-toggle-btn {
        border: none;
        background: transparent;
        color: var(--text-sec, #7b8099);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        padding: 5px 11px;
        border-radius: 999px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .lang-toggle-btn.active {
        background: var(--gold, #f0b429);
        color: #0a0b0d;
      }
      .lang-toggle-btn:not(.active):hover {
        color: var(--text-pri, #e8eaf0);
      }
    `;
    document.head.appendChild(style);
  }

  function buildToggleEl() {
    injectToggleStyles();
    const wrap = document.createElement("div");
    wrap.className = "lang-toggle";
    wrap.innerHTML = `
      <button type="button" class="lang-toggle-btn" data-lang="id">ID</button>
      <button type="button" class="lang-toggle-btn" data-lang="en">EN</button>
    `;
    wrap.querySelectorAll(".lang-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => setLanguage(btn.getAttribute("data-lang")));
    });
    return wrap;
  }

  // Sisipkan toggle switcher ID/EN ke dalam elemen container (by id atau elemen langsung)
  function renderLangToggle(target) {
    const container = typeof target === "string" ? document.getElementById(target) : target;
    if (!container) return;
    container.appendChild(buildToggleEl());
  }

  function initI18n(dict) {
    currentDict = dict || {};
    const lang = getSavedLang();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => applyLanguage(lang));
    } else {
      applyLanguage(lang);
    }
  }

  window.initI18n = initI18n;
  window.setLanguage = setLanguage;
  window.renderLangToggle = renderLangToggle;
  window.getCurrentLang = () => currentLang;
  window.t = t;
})();
