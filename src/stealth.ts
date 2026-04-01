/**
 * Facebook ve genel bot tespitini zorlaştırmak için tarayıcı ayarları.
 * navigator.webdriver, automation flag'leri ve davranış taklidi.
 */

/** Sayfa yüklenmeden önce enjekte edilecek script (addInitScript ile kullan). */
export const STEALTH_INIT_SCRIPT = `
(function() {
  // 1) navigator.webdriver'ı false/undefined yap (en güçlü bot sinyali)
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: function() { return false; },
      configurable: true,
      enumerable: true
    });
  } catch (e) {}
  try {
    delete Object.getPrototypeOf(navigator).webdriver;
  } catch (e) {}

  // 2) Chrome runtime (headless/automation tespiti)
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = { id: undefined, connect: function() {}, sendMessage: function() {} };
  }

  // 3) Permissions API - gerçek tarayıcı gibi dön
  var origQuery = navigator.permissions && navigator.permissions.query && navigator.permissions.query.bind(navigator.permissions);
  if (origQuery) {
    navigator.permissions.query = function(params) {
      if (params.name === 'notifications') return Promise.resolve({ state: Notification.permission });
      return origQuery(params);
    };
  }
})();
`;

/** Tarayıcıyı "automation" olarak işaretleyen flag'leri kapatmak için launch argümanları. */
export const STEALTH_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-popup-blocking",
  "--disable-save-password-bubble",
  "--no-sandbox",
  "--disable-setuid-sandbox",
];

/** Gerçek Chrome (Windows) User-Agent. */
export const REALISTIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** İnsan benzeri yazma: karakterler arası rastgele gecikme (ms). */
export function humanTypingDelay(): number {
  return 28 + Math.floor(Math.random() * 55);
}

/** İnsan benzeri kısa bekleme (tıklama öncesi/sonrası). */
export function humanActionDelay(): number {
  return 100 + Math.floor(Math.random() * 180);
}
