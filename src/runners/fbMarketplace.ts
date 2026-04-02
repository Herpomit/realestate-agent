import fs from "fs";
import path from "path";
import { chromium, type Locator, type Page } from "playwright";
import type { FbCredentials } from "../credentials.js";
import {
  REALISTIC_USER_AGENT,
  STEALTH_INIT_SCRIPT,
  STEALTH_LAUNCH_ARGS,
  humanActionDelay,
  humanTypingDelay,
} from "../stealth.js";

const LOGIN_WAIT_MS = 3 * 60 * 1000; // 3 dakika
const TWO_FA_WAIT_MS = 10 * 60 * 1000; // 10 dakika (2FA / cihaz onayı)

async function isTwoFactorChallenge(page: Page): Promise<boolean> {
  const selectors = [
    'input[name="approvals_code"]',
    "input#approvals_code",
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"][maxlength="6"]',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 750 })) return true;
    } catch {
      // ignore
    }
  }

  const textHints = [
    /iki adımlı doğrulama/i,
    /giriş kodu/i,
    /authentication code/i,
    /two-factor/i,
  ];
  for (const re of textHints) {
    try {
      if (await page.getByText(re).first().isVisible({ timeout: 750 }))
        return true;
    } catch {
      // ignore
    }
  }

  return false;
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  return new Promise((r) => setTimeout(r, ms));
}

function safeKey(key: string) {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

type EmbeddedCredential = {
  id: string;
  email: string;
  password: string;
  label?: string;
};

function resolvePostsToRun(payload: any): any[] {
  const posts = Array.isArray(payload?.posts) ? (payload.posts as any[]) : [];
  const selectedIds = Array.isArray(payload?.postTemplateIds)
    ? (payload.postTemplateIds as string[])
    : [];

  if (posts.length > 0) {
    const byIdOk = posts.every((p) => p && typeof p.id === "string");
    if (selectedIds.length > 0 && byIdOk) {
      const picked = posts.filter((p) => selectedIds.includes(String(p.id)));
      return picked.length > 0 ? picked : posts;
    }
    return posts;
  }

  // Back-compat: old payloads send a single post object at payload.post
  if (payload?.post) return [payload.post];
  return [];
}

function resolveCredentialsToRun(
  payload: any,
  fbCredentials?: FbCredentials | null,
  fallbackId = "single",
): EmbeddedCredential[] {
  const selected = Array.isArray(payload?.selectedFacebookCredentials)
    ? (payload.selectedFacebookCredentials as any[])
    : [];
  const embedded = Array.isArray(payload?.facebookCredentials)
    ? (payload.facebookCredentials as any[])
    : [];
  const ids = Array.isArray(payload?.facebookCredentialIds)
    ? (payload.facebookCredentialIds as string[])
    : [];

  const normalize = (c: any): EmbeddedCredential | null => {
    const id = typeof c?.id === "string" ? String(c.id) : "";
    const email = String(c?.email ?? "");
    const password = String(c?.password ?? "");
    const label = c?.label ? String(c.label) : undefined;
    if (!id || !email || !password) return null;
    return { id, email, password, label };
  };

  const fromSelected = selected
    .map(normalize)
    .filter(Boolean) as EmbeddedCredential[];
  if (fromSelected.length > 0) return fromSelected;

  if (embedded.length > 0 && ids.length > 0) {
    const fromEmbedded = embedded
      .filter(
        (c) => c && typeof c.id === "string" && ids.includes(String(c.id)),
      )
      .map(normalize)
      .filter(Boolean) as EmbeddedCredential[];
    if (fromEmbedded.length > 0) return fromEmbedded;
  }

  if (fbCredentials?.email && fbCredentials?.password) {
    return [
      {
        id: fallbackId,
        email: fbCredentials.email,
        password: fbCredentials.password,
      },
    ];
  }

  return [];
}

/** Giriş yapılmış mı: sadece "giriş yapıldı" kanıtına bakıyoruz (Marketplace/Profil linki) */
async function isLoggedIn(page: Page): Promise<boolean> {
  const loggedInSelectors = [
    'a[href*="/marketplace"]',
    'a[href*="/me/"]',
    '[aria-label="Profil"]',
    '[aria-label="Profile"]',
    '[data-pagelet="LeftRail"]',
  ];
  for (const sel of loggedInSelectors) {
    const el = page.locator(sel).first();
    try {
      if (await el.isVisible({ timeout: 2000 })) return true;
    } catch {
      /* selector yok veya timeout */
    }
  }
  return false;
}

async function logoutFromFacebook(page: Page): Promise<boolean> {
  if (!(await isLoggedIn(page))) return true;

  // Go to a stable surface first; group pages sometimes hide the top bar.
  await page.goto("https://www.facebook.com", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("domcontentloaded");
  await new Promise((r) => setTimeout(r, 1200));

  const profileBtnCandidates = [
    page.getByRole("button", { name: /profilin/i }).first(),
    page.getByRole("button", { name: /your profile|profile/i }).first(),
    page.locator('[role="button"][aria-label="Profilin"]').first(),
    page.locator('[role="button"][aria-label="Profile"]').first(),
    page.locator('[role="button"][aria-label="Your profile"]').first(),
  ];

  let profileBtn: Locator | null = null;
  for (const cand of profileBtnCandidates) {
    try {
      if ((await cand.count()) === 0) continue;
      if (await cand.isVisible({ timeout: 1500 })) {
        profileBtn = cand;
        break;
      }
    } catch {
      // try next
    }
  }
  if (!profileBtn) {
    console.warn("⚠️  Profil menüsü bulunamadı, logout atlanıyor.");
    return false;
  }

  await profileBtn.click().catch(() => {});
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  const logoutCandidates = [
    page.getByRole("menuitem", { name: /çıkış yap|log out/i }).first(),
    page.getByRole("button", { name: /çıkış yap|log out/i }).first(),
    page
      .locator('div[role="button"], a[role="link"], span[role="button"]')
      .filter({ hasText: /Çıkış yap|Log out/i })
      .first(),
  ];

  let logoutBtn: Locator | null = null;
  for (const cand of logoutCandidates) {
    try {
      if ((await cand.count()) === 0) continue;
      if (await cand.isVisible({ timeout: 1500 })) {
        logoutBtn = cand;
        break;
      }
    } catch {
      // try next
    }
  }
  if (!logoutBtn) {
    console.warn("⚠️  'Çıkış yap' bulunamadı, logout atlanıyor.");
    return false;
  }

  console.log("🚪 Çıkış yapılıyor...");
  await logoutBtn.click().catch(() => {});

  // Wait until we are no longer logged-in or we land on picker/login.
  try {
    await Promise.race([
      page.waitForURL(
        (url) =>
          url.hostname === "www.facebook.com" &&
          (url.pathname.startsWith("/login") || url.pathname === "/"),
        { timeout: 45000 },
      ),
      page
        .locator('[role="button"][aria-label="Başka bir profil kullan"]')
        .first()
        .waitFor({ state: "visible", timeout: 45000 }),
      page
        .getByRole("button", { name: /başka bir profil kullan/i })
        .first()
        .waitFor({ state: "visible", timeout: 45000 }),
    ]);
  } catch {
    // continue
  }

  // One last check; sometimes FB keeps you on the homepage but logged out.
  return !(await isLoggedIn(page));
}

/** Giriş sayfasındayız mı (e-posta + şifre alanları) */
async function isLoginPage(page: Page): Promise<boolean> {
  const email = page.locator('input[name="email"], input#email').first();
  const pass = page
    .locator('input[name="pass"], input[type="password"]')
    .first();
  const hasEmail = (await email.count()) > 0 && (await email.isVisible());
  const hasPass = (await pass.count()) > 0 && (await pass.isVisible());
  return hasEmail && hasPass;
}

/** Bazı durumlarda FB "hesap seçici" ekranında kalır; "Başka bir profil kullan" ile login formuna geç. */
async function trySelectRememberedAccountFromPicker(
  page: Page,
  preferredLabel?: string,
): Promise<boolean> {
  const expected = preferredLabel?.trim();
  if (!expected) return false;

  const headingVisible = await page
    .getByText(/Facebook'a Giriş Yap|Log into Facebook/i)
    .first()
    .isVisible({ timeout: 1200 })
    .catch(() => false);
  if (!headingVisible) return false;

  const exactRe = new RegExp(`^${escapeRegExp(expected)}$`, "i");
  const candidates = [
    page
      .locator('[role="button"]')
      .filter({
        has: page.locator("span").filter({ hasText: exactRe }),
      })
      .first(),
    page
      .locator('div[role="button"], a[role="link"]')
      .filter({ hasText: exactRe })
      .first(),
  ];

  let accountBtn: Locator | null = null;
  for (const cand of candidates) {
    try {
      if ((await cand.count()) === 0) continue;
      if (await cand.isVisible({ timeout: 1000 })) {
        accountBtn = cand;
        break;
      }
    } catch {
      // try next
    }
  }
  if (!accountBtn) return false;

  console.log(
    `👤 Kayıtlı hesap seçici bulundu, "${expected}" profiline direkt giriliyor...`,
  );
  await accountBtn.click({ timeout: 10000 }).catch(() => {});

  try {
    await Promise.race([
      page.waitForLoadState("domcontentloaded", { timeout: 20000 }),
      page.waitForURL(
        (url) =>
          url.hostname === "www.facebook.com" &&
          !url.pathname.startsWith("/login"),
        { timeout: 20000 },
      ),
    ]);
  } catch {
    // continue with state checks below
  }

  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

async function trySubmitPasswordOnlyStep(
  page: Page,
  credentials: FbCredentials | null,
): Promise<boolean> {
  if (!credentials?.password) return false;

  const pass = page
    .locator('input[name="pass"], input[type="password"]')
    .first();
  const email = page.locator('input[name="email"], input#email').first();

  const hasPass = await pass.isVisible({ timeout: 1200 }).catch(() => false);
  const hasEmail = await email.isVisible({ timeout: 1200 }).catch(() => false);
  if (!hasPass || hasEmail) return false;

  console.log("🔐 Kayıtlı profil için şifre adımı açıldı, şifre giriliyor...");
  await fillLoginField(pass, credentials.password);
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  const loginBtn = page
    .locator(
      'button[name="login"], button[type="submit"], [role="button"][aria-label*="giriş" i], [role="button"][aria-label*="log in" i]',
    )
    .first();
  const loginBtnByText = page.getByRole("button", {
    name: /giriş yap|log in|devam et|continue/i,
  });

  try {
    if (await loginBtn.isVisible({ timeout: 1500 })) {
      await loginBtn.click();
    } else if (await loginBtnByText.first().isVisible({ timeout: 1500 })) {
      await loginBtnByText.first().click();
    } else {
      await pass.press("Enter");
    }
  } catch {
    await pass.press("Enter").catch(() => {});
  }

  try {
    await Promise.race([
      page.waitForURL(
        (url) =>
          url.hostname === "www.facebook.com" &&
          !url.pathname.startsWith("/login"),
        { timeout: LOGIN_WAIT_MS },
      ),
      page.waitForLoadState("domcontentloaded", { timeout: LOGIN_WAIT_MS }),
    ]);
  } catch {
    // continue with logged-in check below
  }

  await new Promise((r) => setTimeout(r, 2000));
  return await isLoggedIn(page);
}

async function tryGoToLoginFormFromAccountPicker(page: Page): Promise<boolean> {
  const otherProfileCandidates = [
    page.getByRole("button", { name: /başka bir profil kullan/i }).first(),
    page
      .locator('[role="button"][aria-label="Başka bir profil kullan"]')
      .first(),
    page.getByRole("button", { name: /log into another account/i }).first(),
  ];

  let btn: Locator | null = null;
  for (const cand of otherProfileCandidates) {
    try {
      if ((await cand.count()) === 0) continue;
      if (await cand.isVisible({ timeout: 750 })) {
        btn = cand;
        break;
      }
    } catch {
      // try next
    }
  }
  if (!btn) return false;

  console.log(
    "👤 Hesap seçici ekranı algılandı, 'Başka bir profil kullan' tıklanıyor...",
  );
  await btn.click({ timeout: 10000 });

  const email = page.locator('input[name="email"], input#email').first();
  const pass = page
    .locator('input[name="pass"], input[type="password"]')
    .first();
  await Promise.race([
    email.waitFor({ state: "visible", timeout: 20000 }),
    pass.waitFor({ state: "visible", timeout: 20000 }),
    page
      .locator('form#login_form, form[action*="/login/"]')
      .first()
      .waitFor({ state: "visible", timeout: 20000 }),
  ]).catch(() => {});

  await new Promise((r) => setTimeout(r, 800));
  return true;
}

async function fillLoginField(input: Locator, value: string): Promise<void> {
  const delayMs = humanTypingDelay();

  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.scrollIntoViewIfNeeded().catch(() => {});

  try {
    await input.fill("");
    await input.pressSequentially(value, { delay: delayMs });
    return;
  } catch {
    // Some FB overlays intercept pointer events; fall back below.
  }

  try {
    await input.focus();
    await input.evaluate((el) => {
      const field = el as HTMLInputElement;
      field.value = "";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await input.pressSequentially(value, { delay: delayMs });
    return;
  } catch {
    // Final fallback sets the value directly and dispatches events.
  }

  await input.evaluate((el, nextValue) => {
    const field = el as HTMLInputElement;
    field.focus();
    field.value = String(nextValue ?? "");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value);
}

async function tryAutoLogin(
  page: Page,
  credentials: FbCredentials,
): Promise<boolean> {
  if (!(await isLoginPage(page))) return false;

  const email = page.locator('input[name="email"], input#email').first();
  const pass = page
    .locator('input[name="pass"], input[type="password"]')
    .first();

  console.log("🔐 Login sayfası bulundu, otomatik giriş deneniyor...");
  await fillLoginField(email, credentials.email);
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  await fillLoginField(pass, credentials.password);
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  const loginBtn = page
    .locator('button[name="login"], button[type="submit"]')
    .first();
  try {
    if (await loginBtn.isVisible({ timeout: 2000 })) {
      await loginBtn.click();
    } else {
      await pass.press("Enter");
    }
  } catch {
    await pass.press("Enter");
  }

  try {
    await Promise.race([
      page.waitForURL(
        (url) =>
          url.pathname !== "/login" &&
          !url.pathname.startsWith("/login/") &&
          url.hostname === "www.facebook.com",
        { timeout: LOGIN_WAIT_MS },
      ),
      page.waitForLoadState("domcontentloaded", { timeout: LOGIN_WAIT_MS }),
    ]);
  } catch {
    // continue to logged-in check below
  }

  await new Promise((r) => setTimeout(r, 2000));
  return await isLoggedIn(page);
}

async function ensureLoggedIn(
  page: Page,
  credentials: FbCredentials | null,
  preferredLabel?: string,
): Promise<void> {
  await randomDelay(200, 600);
  await page.goto("https://www.facebook.com", {
    waitUntil: "domcontentloaded",
  });

  await page.waitForLoadState("domcontentloaded");
  await new Promise((r) => setTimeout(r, 900)); // Sayfa yerleşsin

  if (await isLoggedIn(page)) {
    console.log("✅ Zaten giriş yapılmış (profil oturumu kullanılıyor).");
    return;
  }

  // Hesap seçicide hedef profil görünüyorsa direkt o profile gir.
  const usedRememberedAccount = await trySelectRememberedAccountFromPicker(
    page,
    preferredLabel,
  );
  if (usedRememberedAccount) {
    const completedPasswordOnly = await trySubmitPasswordOnlyStep(
      page,
      credentials,
    );
    if (completedPasswordOnly && (await isLoggedIn(page))) {
      console.log("✅ Kayıtlı profil şifresi girilerek giriş tamamlandı.");
      return;
    }
  }
  if (usedRememberedAccount && (await isLoggedIn(page))) {
    console.log("✅ Kayıtlı profil üzerinden giriş algılandı.");
    return;
  }

  // Hesap seçici ekranı varsa login formuna geç.
  await tryGoToLoginFormFromAccountPicker(page);

  if (!(await isLoginPage(page))) {
    console.log("⚠️  Giriş sayfası bekleniyor, kısa süre daha bekleniyor...");
    await new Promise((r) => setTimeout(r, 2500));
    if (await isLoggedIn(page)) {
      console.log("✅ Giriş algılandı.");
      return;
    }
    const usedRememberedAccountRetry =
      await trySelectRememberedAccountFromPicker(page, preferredLabel);
    if (usedRememberedAccountRetry) {
      const completedPasswordOnlyRetry = await trySubmitPasswordOnlyStep(
        page,
        credentials,
      );
      if (completedPasswordOnlyRetry && (await isLoggedIn(page))) {
        console.log("✅ Kayıtlı profil şifresi girilerek giriş tamamlandı.");
        return;
      }
    }
    if (usedRememberedAccountRetry && (await isLoggedIn(page))) {
      console.log("✅ Kayıtlı profil üzerinden giriş algılandı.");
      return;
    }
    await tryGoToLoginFormFromAccountPicker(page);
    if (!(await isLoginPage(page))) {
      throw new Error(
        "Facebook giriş sayfası algılanamadı. chromeProfilePath ile kendi Chrome profilinizi kullanmayı deneyin.",
      );
    }
  }

  if (credentials) {
    const ok = await tryAutoLogin(page, credentials);
    if (ok) {
      console.log("✅ Otomatik giriş başarılı.");
      return;
    }
    if (await isTwoFactorChallenge(page)) {
      console.log("🔐 2 adımlı doğrulama ekranı algılandı.");
      console.log("   Açılan pencerede kodu girip doğrulamayı tamamlayın.");
      console.log(`   ${TWO_FA_WAIT_MS / 60000} dakika bekleniyor...`);
    } else {
      console.log("⚠️  Otomatik giriş başarısız, manuel girişe düşülüyor...");
    }
  }

  console.log("");
  console.log("⚠️  Facebook girişi gerekiyor.");
  console.log("   Açılan pencerede e-posta ve şifrenizle giriş yapın.");
  console.log(`   ${LOGIN_WAIT_MS / 60000} dakika bekleniyor...`);
  console.log("");

  try {
    const start = Date.now();
    let told2fa = false;
    while (Date.now() - start < LOGIN_WAIT_MS + TWO_FA_WAIT_MS) {
      if (await isLoggedIn(page)) {
        console.log("✅ Giriş algılandı, devam ediliyor.");
        return;
      }

      if (!told2fa && (await isTwoFactorChallenge(page))) {
        told2fa = true;
        console.log("🔐 2 adımlı doğrulama (2FA) gerekli.");
        console.log("   Telefon onayı / SMS / Authenticator kodunu girin.");
        console.log(
          `   Toplam bekleme: ${(LOGIN_WAIT_MS + TWO_FA_WAIT_MS) / 60000} dakika.`,
        );
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("timeout");
  } catch {
    throw new Error(
      "Facebook girişi tamamlanmadı (2FA dahil). Lütfen pencerede doğrulamayı bitirip tekrar deneyin.",
    );
  }
}

/** Marketplace'te çıkan giriş modalını doldurup Giriş Yap'a basar. */
async function tryDismissMarketplaceLoginModal(
  page: Page,
  credentials: FbCredentials | null,
): Promise<boolean> {
  if (!credentials) return false;

  const loginForm = page
    .locator(
      'form#login_popup_cta_form, form[action*="/login/device-based/regular/login/"]',
    )
    .first();
  const emailInput = loginForm
    .locator('input[name="email"], input#email')
    .first();
  const passInput = loginForm
    .locator('input[name="pass"], input[type="password"]')
    .first();

  try {
    await loginForm.waitFor({ state: "visible", timeout: 5000 });
  } catch {
    return false;
  }

  const hasEmail = await emailInput.isVisible();
  const hasPass = await passInput.isVisible();
  if (!hasEmail || !hasPass) return false;

  console.log("🔐 Marketplace giriş modalı bulundu, otomatik dolduruluyor...");

  await fillLoginField(emailInput, credentials.email);
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  await fillLoginField(passInput, credentials.password);
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  const loginBtn = loginForm
    .locator(
      '[role="button"][aria-label*="giriş" i], [role="button"][aria-label*="log in" i]',
    )
    .first();
  const loginBtnByText = loginForm.getByRole("button", {
    name: /giriş yap|log in/i,
  });
  await new Promise((r) => setTimeout(r, humanActionDelay()));
  try {
    if (await loginBtn.isVisible({ timeout: 2000 })) {
      await loginBtn.click();
    } else if (await loginBtnByText.first().isVisible({ timeout: 2000 })) {
      await loginBtnByText.first().click();
    } else {
      await passInput.press("Enter");
    }
  } catch {
    await passInput.press("Enter");
  }
  console.log("✅ Giriş Yap tıklandı, sayfa güncelleniyor...");

  await page.waitForLoadState("domcontentloaded");
  await new Promise((r) => setTimeout(r, 1800));
  return true;
}

async function ensureGroupPageAccess(
  page: Page,
  groupUrl: string,
  credentials: FbCredentials | null,
): Promise<void> {
  console.log("👥 Grup sayfası açılıyor:", groupUrl);

  const openGroupPage = async () => {
    await page.goto(groupUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded");
    await new Promise((r) => setTimeout(r, 900));
    await tryGoToLoginFormFromAccountPicker(page);
  };

  await openGroupPage();

  if (await isLoginPage(page)) {
    console.log(
      "🔐 Grup sayfasında tekrar giriş ekranı açıldı, otomatik giriş deneniyor...",
    );
    const ok = credentials ? await tryAutoLogin(page, credentials) : false;
    if (!ok) {
      throw new Error(
        "Grup sayfasında Facebook giriş ekranı açıldı ve otomatik giriş başarısız oldu.",
      );
    }
    await randomDelay(250, 700);
    await openGroupPage();
  }

  const modalDismissed = await tryDismissMarketplaceLoginModal(
    page,
    credentials,
  );
  if (modalDismissed) {
    await randomDelay(250, 700);
    await openGroupPage();
  }

  if (await isLoginPage(page)) {
    throw new Error(
      "Grup sayfası tekrar giriş ekranında kaldı. Facebook hesabını kontrol edin.",
    );
  }
}

async function clickFirst(loc: ReturnType<Page["locator"]>, timeoutMs = 20000) {
  const el = loc.first();
  await el.waitFor({ state: "visible", timeout: timeoutMs });
  await el.click();
}

async function getSellFormRoot(page: Page): Promise<Locator> {
  // Prefer a modal/dialog that contains the sell form fields.
  const dialogByFields = page
    .locator('[role="dialog"], [aria-modal="true"]')
    .filter({ has: page.locator('input[placeholder="Başlık"]') })
    .filter({ has: page.locator('input[placeholder="Fiyat"]') })
    .first();

  try {
    if ((await dialogByFields.count()) > 0) {
      await dialogByFields.waitFor({ state: "visible", timeout: 15000 });
      return dialogByFields;
    }
  } catch {
    // ignore
  }

  // Some UIs don't use placeholder attributes; prefer label-based detection.
  const dialogByLabels = page
    .locator('[role="dialog"], [aria-modal="true"]')
    .filter({ has: page.locator("label").filter({ hasText: /^Başlık$/i }) })
    .filter({ has: page.locator("label").filter({ hasText: /^Fiyat$/i }) })
    .first();
  try {
    if ((await dialogByLabels.count()) > 0) {
      await dialogByLabels.waitFor({ state: "visible", timeout: 15000 });
      return dialogByLabels;
    }
  } catch {
    // ignore
  }

  // Fallback: a modal that contains the photo upload call-to-action.
  const dialogByPhoto = page
    .locator('[role="dialog"], [aria-modal="true"]')
    .filter({ hasText: /Fotoğraflar ekle/i })
    .first();
  try {
    if ((await dialogByPhoto.count()) > 0) {
      await dialogByPhoto.waitFor({ state: "visible", timeout: 15000 });
      return dialogByPhoto;
    }
  } catch {
    // ignore
  }

  // Last resort: a unique container with Başlık + Fiyat.
  const byFields = page
    .locator("div")
    .filter({ has: page.locator('input[placeholder="Başlık"]') })
    .filter({ has: page.locator('input[placeholder="Fiyat"]') })
    .first();

  try {
    await byFields.waitFor({ state: "visible", timeout: 15000 });
    return byFields;
  } catch {
    const byLabels = page
      .locator("div")
      .filter({ has: page.locator("label").filter({ hasText: /^Başlık$/i }) })
      .filter({ has: page.locator("label").filter({ hasText: /^Fiyat$/i }) })
      .first();
    await byLabels.waitFor({ state: "visible", timeout: 15000 });
    return byLabels;
  }
}

function fieldByLabel(root: Locator, labelText: RegExp) {
  // Facebook form fields are often wrapped by <label> ... <textarea|input|contenteditable>
  return root
    .locator("label")
    .filter({ hasText: labelText })
    .locator('textarea, input, [contenteditable="true"][role="textbox"]')
    .first();
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function openProfileMenu(page: Page) {
  const profileBtnCandidates = [
    page.getByRole("button", { name: /profilin/i }).first(),
    page.getByRole("button", { name: /your profile|profile/i }).first(),
    page.locator('[role="button"][aria-label="Profilin"]').first(),
    page.locator('[role="button"][aria-label="Profile"]').first(),
    page.locator('[role="button"][aria-label="Your profile"]').first(),
  ];

  let profileBtn: Locator | null = null;
  for (const cand of profileBtnCandidates) {
    try {
      if ((await cand.count()) === 0) continue;
      if (await cand.isVisible({ timeout: 1500 })) {
        profileBtn = cand;
        break;
      }
    } catch {
      // try next
    }
  }
  if (!profileBtn) return false;

  await profileBtn.click().catch(() => {});
  await new Promise((r) => setTimeout(r, humanActionDelay()));
  return true;
}

async function getActiveProfileNameFromMenu(
  page: Page,
): Promise<string | null> {
  // Best-effort: FB DOM changes often; we only need a stable signal.
  const menuCandidates = [
    page.locator('[role="menu"]').last(),
    page.locator('div[role="dialog"][aria-label]').last(),
    page.locator('div[role="dialog"], div[aria-modal="true"]').last(),
  ];

  for (const menu of menuCandidates) {
    try {
      if ((await menu.count()) === 0) continue;
      if (!(await menu.isVisible({ timeout: 1500 }))) continue;

      const nameEl = menu.locator('span[dir="auto"]').first();
      if ((await nameEl.count()) === 0) continue;
      const txt = (await nameEl.textContent().catch(() => ""))?.trim();
      if (txt && txt.length >= 2) return txt;
    } catch {
      // try next
    }
  }

  return null;
}

async function isCorrectFacebookAccount(page: Page, expectedLabel?: string) {
  const expected = expectedLabel?.trim();
  if (!expected) return true;

  // Go to a stable surface first; group pages sometimes hide the top bar.
  await page.goto("https://www.facebook.com", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("domcontentloaded");
  await new Promise((r) => setTimeout(r, 1000));

  const opened = await openProfileMenu(page);
  if (!opened) {
    console.warn("⚠️  Profil menüsü açılamadı, hesap doğrulama atlanıyor.");
    return true;
  }

  // Presence check for expected label in the opened menu.
  const expectedRe = new RegExp(`\\b${escapeRegExp(expected)}\\b`, "i");
  const appears = await page
    .locator('span[dir="auto"]')
    .filter({ hasText: expectedRe })
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  await page.keyboard.press("Escape").catch(() => {});
  if (appears) return true;

  return false;
}

async function ensureCorrectFacebookAccount(
  page: Page,
  expectedLabel: string | undefined,
  credentials: FbCredentials,
) {
  const expected = expectedLabel?.trim();
  if (!expected) return;

  // 1) If already correct, continue.
  if (await isCorrectFacebookAccount(page, expected)) return;

  console.warn(
    `⚠️  Hesap uyuşmazlığı (beklenen="${expected}"). Otomatik çıkış + tekrar giriş deneniyor...`,
  );

  // 2) Try to recover: logout -> login with intended credentials -> re-check
  await logoutFromFacebook(page).catch(() => false);
  await new Promise((r) => setTimeout(r, 1200));
  await ensureLoggedIn(page, credentials, expected);
  if (await isCorrectFacebookAccount(page, expected)) return;

  // 3) Manual fallback: keep the window open and wait for the user to switch account.
  const waitMs = 4 * 60 * 1000; // 4 minutes
  console.log("");
  console.log("⚠️  Hesap hala beklenen değil.");
  console.log(`   Beklenen hesap etiketi: "${expected}"`);
  console.log(
    "   Açık pencerede doğru hesaba geçiş yapın (profil menüsünden).",
  );
  console.log(`   ${waitMs / 60000} dakika bekleniyor...`);
  console.log("");

  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (await isCorrectFacebookAccount(page, expected)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const actual = await getActiveProfileNameFromMenu(page);
  throw new Error(
    `Hesap uyuşmazlığı: beklenen="${expected}", görünen="${actual ?? "?"}".`,
  );
}

async function selectListboxOptionByPrefix(
  page: Page,
  root: Locator,
  prefix: string,
) {
  const p = prefix.trim();
  if (!p) return;

  // listbox is usually rendered in a portal (outside modal), so we search on page.
  // We intentionally do NOT depend on "önerilen arama" copy since it can vary.
  const listbox = page
    .locator('[role="listbox"]')
    .filter({ has: page.locator('[role="option"]') })
    .last();

  await listbox.waitFor({ state: "visible", timeout: 15000 });

  const prefixRe = new RegExp(`^${escapeRegExp(p)}(,|\\s|$)`, "i");

  // Prefer an option that contains an exact first-line match (e.g. "Antalya")
  const optBySpan = listbox
    .locator('[role="option"]')
    .filter({
      has: listbox
        .locator("span")
        .filter({ hasText: new RegExp(`^${escapeRegExp(p)}$`, "i") }),
    })
    .first();

  const optByText = listbox
    .locator('[role="option"]')
    .filter({ hasText: prefixRe })
    .first();

  let clicked = false;
  for (const candidate of [optBySpan, optByText]) {
    try {
      if ((await candidate.count()) === 0) continue;
      await candidate.waitFor({ state: "visible", timeout: 5000 });
      await candidate.click();
      clicked = true;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!clicked) {
    // Fallback: keyboard select first suggestion
    await page.keyboard.press("ArrowDown").catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await page.keyboard.press("Enter").catch(() => {});
  }

  // Wait listbox to disappear
  await listbox.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, humanActionDelay()));
}

async function fillIfFound(
  page: Page,
  candidates: Array<ReturnType<Page["locator"]>>,
  value: string,
) {
  if (!value) return false;
  const delayMs = 10 + Math.floor(Math.random() * 12);
  const selectAllCombo = process.platform === "darwin" ? "Meta+A" : "Control+A";
  for (const loc of candidates) {
    try {
      const el = loc.first();
      if ((await el.count()) === 0) continue;
      await el.waitFor({ state: "visible", timeout: 2000 });
      await el.click({ timeout: 2000 }).catch(() => {});
      await randomDelay(20, 50);
      try {
        await el.fill("");
        await el.fill(value);
        return true;
      } catch {
        // Some FB fields don't fully support fill(); use keyboard fallback below.
      }
      await el.press(selectAllCombo).catch(() => {});
      await randomDelay(20, 50);
      await el.press("Backspace").catch(() => {});
      await randomDelay(20, 50);
      await el.pressSequentially(value, { delay: delayMs });
      await randomDelay(20, 50);
      return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

async function ensureCheckboxCheckedByText(
  scopes: Array<Page | Locator>,
  labelRe: RegExp,
  displayName: string,
): Promise<void> {
  let cb: Locator | null = null;
  for (const scope of scopes) {
    const cand = scope
      .locator('[role="checkbox"]')
      .filter({ hasText: labelRe })
      .first();
    if ((await cand.count().catch(() => 0)) > 0) {
      cb = cand;
      break;
    }
  }

  if (!cb) throw new Error(`Checkbox bulunamadı: "${displayName}"`);

  await cb.scrollIntoViewIfNeeded().catch(() => {});
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  const checkedBefore = await cb.getAttribute("aria-checked").catch(() => null);
  if (checkedBefore === "true") return;

  await cb.click({ timeout: 10000 });
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  for (let i = 0; i < 12; i++) {
    const now = await cb.getAttribute("aria-checked").catch(() => null);
    if (now === "true") return;
    await new Promise((r) => setTimeout(r, 150));
  }

  const checkedAfter = await cb.getAttribute("aria-checked").catch(() => null);
  if (checkedAfter !== "true") {
    throw new Error(`Checkbox işaretlenemedi: "${displayName}"`);
  }
}

async function ensureMeetupPreferencesChecked(
  page: Page,
  root: Locator,
): Promise<void> {
  // Best-effort wait: this block appears on the details step right before “İleri”.
  await Promise.race([
    root
      .locator("text=/Buluşma tercihleri/i")
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => {}),
    page
      .locator("text=/Buluşma tercihleri/i")
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => {}),
  ]).catch(() => {});

  await ensureCheckboxCheckedByText(
    [root, page],
    /Herkese\s*aç[ıi]k.*buluşma/i,
    "Herkese açık bir yerde buluşma",
  );
  await ensureCheckboxCheckedByText(
    [root, page],
    /Kap[ıi]da\s*teslim\s*alma/i,
    "Kapıda teslim alma",
  );
  await ensureCheckboxCheckedByText(
    [root, page],
    /Kap[ıi]ya\s*b[ıi]rakma/i,
    "Kapıya bırakma",
  );
}

async function selectCondition(page: Page, statusText: string) {
  const target = statusText?.trim().length ? statusText.trim() : "Yeni";

  const targetRe = new RegExp(`^${escapeRegExp(target)}$`, "i");

  const statusKey = (() => {
    const s = target.toLowerCase();
    if (/\byeni\b/i.test(target) || /\bnew\b/i.test(s)) return "new";
    if (/yeni\s*gibi/i.test(s) || /like\s*new/i.test(s)) return "like_new";
    if (/(^|[^a-z])iyi([^a-z]|$)/i.test(s) || /good/i.test(s)) return "good";
    if (/vasat|orta|adil|fair|okay/i.test(s)) return "fair";
    return null;
  })();

  const regexes: RegExp[] = [targetRe];
  if (statusKey === "new") {
    regexes.push(/^Yeni$/i, /^New$/i);
  } else if (statusKey === "like_new") {
    regexes.push(
      /Kullan(ı|i)lm(ı|i)ş\s*-\s*Yeni\s*gibi/i,
      /Used\s*-\s*Like\s*New/i,
      /Like\s*New/i,
    );
  } else if (statusKey === "good") {
    regexes.push(
      /Kullan(ı|i)lm(ı|i)ş\s*-\s*[İI]yi/i,
      /Used\s*-\s*Good/i,
      /\bGood\b/i,
    );
  } else if (statusKey === "fair") {
    regexes.push(
      /Kullan(ı|i)lm(ı|i)ş\s*-\s*(Vasat|Orta|Adil)/i,
      /Used\s*-\s*(Fair|Okay)/i,
      /\bFair\b/i,
    );
  }

  const openers = [
    page.getByRole("combobox", { name: /Durum/i }),
    page.locator('[role="combobox"][aria-label*="Durum" i]'),
    page
      .locator('div[role="button"][aria-expanded]')
      .filter({ hasText: /^Durum$/i }),
    page.locator('div[role="button"]').filter({ hasText: /^Durum$/i }),
  ];

  let opened = false;
  for (const opener of openers) {
    try {
      const el = opener.first();
      if ((await el.count()) === 0) continue;
      await el.waitFor({ state: "visible", timeout: 3000 });
      await el.click();
      opened = true;
      break;
    } catch {
      // try next
    }
  }
  if (!opened) throw new Error("Durum dropdown açılamadı");

  await new Promise((r) => setTimeout(r, 400));

  for (const re of regexes) {
    const optCandidates = [
      page.getByRole("option", { name: re }).first(),
      page.getByRole("menuitem", { name: re }).first(),
      page.locator('[role="option"]').filter({ hasText: re }).first(),
      page.locator("span, div").filter({ hasText: re }).first(),
    ];

    for (const el of optCandidates) {
      try {
        if ((await el.count()) === 0) continue;
        await el.waitFor({ state: "visible", timeout: 5000 });
        await el.click();
        await new Promise((r) => setTimeout(r, 400));
        return;
      } catch {
        // try next
      }
    }
  }

  throw new Error(`Durum seçeneği bulunamadı: ${target}`);
}

async function runGroupSellFlow(
  page: Page,
  payload: any,
  fbCredentials: FbCredentials | null,
) {
  const groupUrl =
    payload?.selectedFacebookGroups?.[0]?.url ||
    payload?.facebookGroups?.[0]?.url ||
    "https://www.facebook.com/groups/500703591569864";

  await ensureGroupPageAccess(page, groupUrl, fbCredentials);

  // 1) "Bir Şey Sat"
  await clickFirst(page.locator('span:has-text("Bir Şey Sat")'));
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  // 2) Modal: "Satılık ürün"
  await clickFirst(page.locator('span:has-text("Satılık ürün")'));
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  const root = await getSellFormRoot(page);

  // 3) Form: medya upload + başlık + fiyat + durum
  const post = payload?.post ?? {};
  const mp = post?.marketplacePayload ?? {};
  const title = String(post?.title ?? "");
  const price = String(mp?.price ?? "");
  const status = String(mp?.status ?? "Yeni"); // default Yeni
  const tags = String(mp?.tags ?? "");
  const location = String(mp?.location ?? "");
  const body = String(post?.body ?? "");
  const mediaPaths = Array.isArray(mp?.mediaFilePaths)
    ? mp.mediaFilePaths
    : Array.isArray(mp?.imageFilePaths)
      ? mp.imageFilePaths
      : [];

  // Photo input (hidden file input)
  if (mediaPaths.length > 0) {
    console.log(`📤 Fotoğraf upload (${mediaPaths.length})...`);
    const counter = root.locator("text=/Fotoğraflar.*\\/\\s*42/i").first();
    await counter.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    const before = await counter.textContent().catch(() => null);

    // Extra safety: ensure files exist (helps diagnose "upload did nothing" cases)
    const missing: string[] = [];
    for (const p of mediaPaths) {
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) missing.push(p);
      } catch {
        missing.push(p);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Medya dosyaları bulunamadı: ${missing.join(", ")}`);
    }

    // Find the actual upload container (several variants exist in FB UI).
    const uploadCandidates = [
      root.getByRole("button", { name: /Fotoğraflar ekle/i }),
      root
        .locator('div[role="button"]')
        .filter({ hasText: /Fotoğraflar ekle/i }),
      root
        .locator('span:has-text("Fotoğraflar ekle")')
        .first()
        .locator('xpath=ancestor::div[@role="button"][1]'),
      root
        .getByText(/Fotoğraflar ekle/i)
        .first()
        .locator(
          'xpath=ancestor::*[self::button or @role="button" or @tabindex="0"][1]',
        ),
    ];

    let uploadBtn: Locator | null = null;
    for (const cand of uploadCandidates) {
      try {
        const el = cand.first();
        if ((await el.count()) === 0) continue;
        await el.waitFor({ state: "visible", timeout: 20000 });
        uploadBtn = el;
        break;
      } catch {
        // try next
      }
    }

    let didSet = false;

    // 1) Best: filechooser event + chooser.setFiles (avoids Windows picker interaction)
    if (uploadBtn) {
      await uploadBtn.scrollIntoViewIfNeeded().catch(() => {});
      await new Promise((r) => setTimeout(r, humanActionDelay()));

      try {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 10000 }),
          uploadBtn.click({ timeout: 10000 }),
        ]);
        await chooser.setFiles(mediaPaths);
        didSet = true;
      } catch (e: any) {
        console.warn(
          "⚠️  filechooser ile setFiles başarısız, input fallback:",
          String(e?.message ?? e),
        );
      }
    }

    // 2) Fallback: setInputFiles on a file input (prefer within modal/root)
    if (!didSet) {
      const inRoot = root.locator('input[type="file"]').last();
      const inPage = page.locator('input[type="file"]').last();

      let fileInput: Locator | null = null;
      try {
        if ((await inRoot.count()) > 0) fileInput = inRoot;
      } catch {
        // ignore
      }
      if (!fileInput) fileInput = inPage;

      // Some UIs only attach the input after interacting with the dropzone.
      if (uploadBtn && (await fileInput.count().catch(() => 0)) === 0) {
        await uploadBtn.click({ timeout: 10000 }).catch(() => {});
      }

      await fileInput.waitFor({ state: "attached", timeout: 15000 });
      await fileInput.setInputFiles(mediaPaths);
      didSet = true;
    }

    // Wait UI to reflect uploaded images (counter changes from 0/x to >=1/x)
    for (let i = 0; i < 30; i++) {
      const now = await counter.textContent().catch(() => null);
      if (now && now !== before && /Fotoğraflar.*[1-9]\d*\s*\/\s*42/i.test(now))
        break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const after = await counter.textContent().catch(() => null);
    if (
      !after ||
      after === before ||
      !/Fotoğraflar.*[1-9]\d*\s*\/\s*42/i.test(after)
    ) {
      throw new Error(
        `Fotoğraf yükleme başarısız: sayaç güncellenmedi (önce="${before ?? ""}", sonra="${after ?? ""}").`,
      );
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  const titleByLabel = fieldByLabel(root, /^Başlık$/i);
  const priceByLabel = fieldByLabel(root, /^Fiyat$/i);

  await fillIfFound(
    page,
    [
      titleByLabel,
      root.locator('input[placeholder="Başlık"]'),
      root.locator('input[aria-label="Başlık"]'),
      root.getByRole("textbox", { name: /Başlık/i }),
    ],
    title,
  );
  if (title && (await titleByLabel.count().catch(() => 0)) >= 0) {
    // if couldn't fill, we want to fail fast rather than silently continue
    const titleVal =
      (await titleByLabel.inputValue().catch(() => "")) ||
      (await root
        .locator('input[aria-label="Başlık"], input[placeholder="Başlık"]')
        .first()
        .inputValue()
        .catch(() => ""));
    if (!titleVal) throw new Error("Başlık alanı doldurulamadı");
  }

  await fillIfFound(
    page,
    [
      priceByLabel,
      root.locator('input[placeholder="Fiyat"]'),
      root.locator('input[aria-label="Fiyat"]'),
      root.getByRole("textbox", { name: /Fiyat/i }),
    ],
    price,
  );
  if (price) {
    const priceVal =
      (await priceByLabel.inputValue().catch(() => "")) ||
      (await root
        .locator('input[aria-label="Fiyat"], input[placeholder="Fiyat"]')
        .first()
        .inputValue()
        .catch(() => ""));
    if (!priceVal) throw new Error("Fiyat alanı doldurulamadı");
  }
  // blur to let FB validate form fields
  await page.keyboard.press("Tab").catch(() => {});
  await new Promise((r) => setTimeout(r, humanActionDelay()));

  // Durum -> Yeni (or payload status if matches)
  try {
    // dropdown lives inside the same modal/root
    await selectCondition(page, status);
  } catch {
    await selectCondition(page, "Yeni");
  }

  // 4) "Diğer detaylar" aç
  const detailsBtn = root
    .locator('div[role="button"][aria-expanded]')
    .filter({ hasText: /Diğer detaylar/i })
    .first();
  const detailsBtnFallback = root
    .locator('span:has-text("Diğer detaylar")')
    .first()
    .locator('xpath=ancestor::div[@role="button"][1]');

  if ((await detailsBtn.count()) > 0) {
    await clickFirst(detailsBtn);
  } else {
    await clickFirst(detailsBtnFallback);
  }

  // Açıldığını doğrula (aria-expanded=true) ve alanların gelmesini bekle
  for (let i = 0; i < 20; i++) {
    const expanded = await detailsBtn
      .getAttribute("aria-expanded")
      .catch(() => null);
    if (expanded === "true") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 450));

  const descByLabel = fieldByLabel(root, /^Açıklama$/i);
  await descByLabel
    .waitFor({ state: "visible", timeout: 20000 })
    .catch(() => {});

  await fillIfFound(
    page,
    [
      descByLabel,
      root.locator('textarea[aria-label="Açıklama"]'),
      root.locator('textarea[placeholder="Açıklama"]'),
      descByLabel,
      root.getByRole("textbox", { name: /Açıklama/i }),
    ],
    body,
  );

  const tagsByLabel = fieldByLabel(root, /^Ürün etiketleri$/i);

  await fillIfFound(
    page,
    [
      tagsByLabel,
      root.locator('[aria-label="Ürün etiketleri"]'),
      root.locator('textarea[placeholder="Ürün etiketleri"]'),
      root.locator('input[placeholder="Ürün etiketleri"]'),
      tagsByLabel,
      root.getByRole("textbox", { name: /Ürün etiketleri/i }),
    ],
    tags,
  );

  if (location) {
    const locByLabel = fieldByLabel(root, /^Konum$/i);

    const ok = await fillIfFound(
      page,
      [
        locByLabel,
        root.getByRole("combobox", { name: /Konum/i }),
        root.locator('[aria-label="Konum"][role="combobox"]'),
        root.locator('input[aria-label="Konum"]'),
        locByLabel,
      ],
      location,
    );
    if (ok) {
      // After typing, select the suggestion from listbox (e.g. Antalya -> Antalya/Şehir)
      await new Promise((r) => setTimeout(r, 350));
      await selectListboxOptionByPrefix(page, root, location);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // 4.5) Buluşma tercihleri (İleri'den önce zorunlu)
  await ensureMeetupPreferencesChecked(page, root);

  // 5) İleri
  const ileri = root
    .locator('div[role="button"]')
    .filter({ hasText: /^İleri$/i })
    .first();
  await ileri.waitFor({ state: "visible", timeout: 20000 });
  // Wait if disabled
  for (let i = 0; i < 20; i++) {
    const disabled = await ileri
      .getAttribute("aria-disabled")
      .catch(() => "false");
    if (disabled !== "true") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await ileri.click();
  await new Promise((r) => setTimeout(r, 1100));

  // 6) “Daha fazla yerde paylaş / ilan ver” akışı:
  // - modal açılırsa: 20'şer grup seç, Paylaş, tekrar aç ve devam et.
  // - hiç modal yoksa: sessizce devam et.
  await shareToMoreGroupsUntilExhausted(page, {
    groupUrl,
    listingTitle: title,
    maxPerBatch: 20,
    maxTotalGroups: 200,
  });
}

function extractFirstLine(text: string): string | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[0] : null;
}

function normalizeComparableText(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("tr-TR");
}

async function ensureMarketplaceSelected(page: Page, dialog: Locator) {
  // On “Daha fazla yerde paylaş”, Marketplace is a separate selectable row.
  // Some UIs render it as role="button", others as role="checkbox".
  // We try hard to select it idempotently (avoid toggling off if already selected).
  const titleRe = /Daha fazla yerde (paylaş|ilan ver)/i;
  const marketplaceSectionTitleRe = /İlanını\s+Marketplace['’]?e\s+ekle/i;
  const marketplaceDescriptionRe =
    /Marketplace ürünleri herkese açıktır|Pazar\s*yeri ürünleri herkese açıktır/i;
  const exactMarketplaceTitleRe = /^Marketplace$|^Pazar\s*yeri$/i;

  const modal = page
    .locator('[role="dialog"], [aria-modal="true"]')
    .filter({ hasText: titleRe })
    .first();

  const scopes: Array<Page | Locator> = [dialog, modal, page];
  let section: Locator | null = null;

  const resolveSection = async (): Promise<Locator | null> => {
    for (const scope of [dialog, modal, page] as Array<Page | Locator>) {
      const candidate = scope
        .locator("div")
        .filter({ hasText: marketplaceSectionTitleRe })
        .filter({ hasText: marketplaceDescriptionRe })
        .first();
      if ((await candidate.count().catch(() => 0)) > 0) return candidate;
    }
    return null;
  };

  const findRow = async (): Promise<Locator | null> => {
    const strictScopes: Array<Page | Locator> = section ? [section] : [];
    const searchScopes: Array<Page | Locator> =
      strictScopes.length > 0 ? strictScopes : scopes;

    for (const scope of searchScopes) {
      const byExactRow = scope
        .locator("div")
        .filter({
          has: scope.locator(`text=/${exactMarketplaceTitleRe.source}/i`),
        })
        .filter({
          has: scope.locator(`text=/${marketplaceDescriptionRe.source}/i`),
        })
        .filter({
          has: scope.locator(
            'svg[viewBox="0 0 24 24"], svg[viewBox="0 0 20 20"]',
          ),
        })
        .first()
        .locator(
          "xpath=ancestor::div[" +
            './/*[normalize-space(.)="Marketplace" or normalize-space(.)="Pazar yeri"]' +
            ' and .//*[contains(normalize-space(.), "Marketplace ürünleri herkese açıktır") or contains(normalize-space(.), "Pazar yeri ürünleri herkese açıktır")]' +
            ' and .//*[name()="svg" and (@viewBox="0 0 24 24" or @viewBox="0 0 20 20")]' +
            "][1]",
        );
      if ((await byExactRow.count().catch(() => 0)) > 0) return byExactRow;

      const byExactDescriptionRow = scope
        .locator(`text=/${marketplaceDescriptionRe.source}/i`)
        .first()
        .locator(
          "xpath=ancestor::div[" +
            './/*[normalize-space(.)="Marketplace" or normalize-space(.)="Pazar yeri"]' +
            ' and .//*[name()="svg" and (@viewBox="0 0 24 24" or @viewBox="0 0 20 20")]' +
            "][1]",
        );
      if ((await byExactDescriptionRow.count().catch(() => 0)) > 0)
        return byExactDescriptionRow;

      const byTitleRow = scope
        .locator(`text=/${exactMarketplaceTitleRe.source}/i`)
        .first()
        .locator(
          "xpath=ancestor::div[" +
            './/*[contains(normalize-space(.), "Marketplace ürünleri herkese açıktır") or contains(normalize-space(.), "Pazar yeri ürünleri herkese açıktır")]' +
            ' and .//*[name()="svg" and (@viewBox="0 0 24 24" or @viewBox="0 0 20 20")]' +
            "][1]",
        );
      if ((await byTitleRow.count().catch(() => 0)) > 0) return byTitleRow;
    }
    return null;
  };

  // Lazy-render: dialog becomes visible before the Marketplace row is in DOM.
  // Retry for a short window before giving up.
  let row: Locator | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    section = section ?? (await resolveSection());
    row = await findRow();
    if (row) break;

    if (attempt === 0) {
      // Wait for the Marketplace section header/description to appear (best-effort).
      await Promise.race([
        dialog
          .locator("text=/İlanını\\s+Marketplace['’]?e\\s+ekle/i")
          .first()
          .waitFor({ state: "visible", timeout: 6000 })
          .catch(() => {}),
        modal
          .locator("text=/İlanını\\s+Marketplace['’]?e\\s+ekle/i")
          .first()
          .waitFor({ state: "visible", timeout: 6000 })
          .catch(() => {}),
        page
          .locator("text=/Marketplace ürünleri/i")
          .first()
          .waitFor({ state: "visible", timeout: 6000 })
          .catch(() => {}),
      ]).catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  if (!row) {
    console.warn(
      '⚠️  "Marketplace" seçeneği bulunamadı (Daha fazla yerde paylaş). Atlanıyor...',
    );
    return;
  }

  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.scrollIntoViewIfNeeded().catch(() => {});

  const readCheckboxIconState = async (
    scope: Locator,
  ): Promise<"checked" | "unchecked" | "unknown"> => {
    const icon = scope.locator('svg[viewBox="0 0 24 24"]').last();
    if ((await icon.count().catch(() => 0)) === 0) return "unknown";

    return await icon
      .evaluate((svg) => {
        const iconStyle = String(svg.getAttribute("style") ?? "");
        const iconPathD =
          svg.querySelector("path")?.getAttribute("d") ??
          svg.querySelector("path:last-of-type")?.getAttribute("d") ??
          "";

        const hasCheckGlyph =
          /1\.414-1\.414/.test(iconPathD) || /3\.535\s+0/.test(iconPathD);
        const accent = /var\(--accent\)/i.test(iconStyle);
        const primary = /var\(--primary-icon\)/i.test(iconStyle);

        if (hasCheckGlyph || accent) return "checked";
        if (primary) return "unchecked";
        return "unknown";
      })
      .catch(() => "unknown");
  };

  const readMarketplaceState = async (): Promise<
    "checked" | "unchecked" | "unknown"
  > => {
    section = section ?? (await resolveSection());
    const currentRow = (await findRow()) ?? row;
    if (!currentRow) return "unknown";
    row = currentRow;

    const iconState = await readCheckboxIconState(currentRow);
    if (iconState !== "unknown") return iconState;

    return await currentRow
      .evaluate((el) => {
        const root = el as HTMLElement;
        const attrs = ["aria-checked", "aria-pressed", "aria-selected"];

        // 1) Direct/descendant aria state is most reliable when available.
        const readAria = (node: Element | null): string | null => {
          if (!node) return null;
          for (const a of attrs) {
            const v = node.getAttribute(a);
            if (v === "true" || v === "false") return v;
          }
          return null;
        };

        const direct = readAria(root);
        if (direct === "true") return "checked";
        if (direct === "false") return "unchecked";

        const desc = root.querySelector<HTMLElement>(
          '[aria-checked], [aria-pressed], [aria-selected], [role="checkbox"]',
        );
        const descVal = readAria(desc);
        if (descVal === "true") return "checked";
        if (descVal === "false") return "unchecked";

        // 2) Visual fallback. Some rows contain multiple SVGs:
        // a left Marketplace icon and a right selection-state icon.
        const svgs = Array.from(root.querySelectorAll<SVGElement>("svg"));
        let sawUncheckedHint = false;
        for (const svg of svgs) {
          const iconStyle = String(svg.getAttribute("style") ?? "");
          const iconPathD =
            svg.querySelector("path")?.getAttribute("d") ??
            svg.querySelector("path:last-of-type")?.getAttribute("d") ??
            "";

          const hasCheckGlyph =
            /1\.414-1\.414/.test(iconPathD) || /3\.535\s+0/.test(iconPathD);
          const accent = /var\(--accent\)/i.test(iconStyle);
          const primary = /var\(--primary-icon\)/i.test(iconStyle);

          if (hasCheckGlyph || accent) return "checked";
          if (primary) sawUncheckedHint = true;
        }

        if (sawUncheckedHint) return "unchecked";
        return "unknown";
      })
      .catch(() => "unknown");
  };

  const state0 = await readMarketplaceState();
  if (state0 === "checked") return;

  const checkboxArea = row.locator(
    'xpath=.//*[name()="svg" and @viewBox="0 0 24 24"][last()]/ancestor::div[1]',
  );
  const checkboxIcon = row.locator('svg[viewBox="0 0 24 24"]').last();

  const waitUntilChecked = async (
    attempts = 18,
    delayMs = 180,
  ): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      const state = await readMarketplaceState();
      if (state === "checked") return true;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  };

  const trySingleClick = async (
    target: Locator,
    mode: "normal" | "force" | "dom",
  ): Promise<boolean> => {
    if ((await target.count().catch(() => 0)) === 0) return false;
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await new Promise((r) => setTimeout(r, humanActionDelay()));

    try {
      if (mode === "normal") {
        await target.click({ timeout: 4000 });
      } else if (mode === "force") {
        await target.click({ timeout: 4000, force: true });
      } else {
        await target.evaluate((node) => {
          (node as HTMLElement).click();
        });
      }
    } catch {
      return false;
    }

    return await waitUntilChecked();
  };

  const clickPlans: Array<{
    target: Locator;
    mode: "normal" | "force" | "dom";
  }> = [
    { target: checkboxArea, mode: "normal" },
    { target: checkboxIcon, mode: "normal" },
    { target: checkboxArea, mode: "force" },
    { target: checkboxIcon, mode: "force" },
    { target: checkboxArea, mode: "dom" },
  ];

  for (const plan of clickPlans) {
    if (await trySingleClick(plan.target, plan.mode)) return;
  }

  const coordinateTargets = [checkboxArea, checkboxIcon, row, section].filter(
    (target): target is Locator => Boolean(target),
  );
  for (const target of coordinateTargets) {
    const box = await target.boundingBox().catch(() => null);
    if (!box) continue;

    const clickX =
      box.x +
      Math.min(box.width - 8, Math.max(box.width - 18, box.width * 0.9));
    const clickY = box.y + box.height / 2;

    await page.mouse.click(clickX, clickY).catch(() => {});
    if (await waitUntilChecked()) return;
  }

  if (await waitUntilChecked(10, 150)) return;

  throw new Error(
    '"Marketplace" seçeneği işaretlenemedi (durum doğrulanamadı).',
  );
}

async function getMorePlacesDialog(page: Page): Promise<Locator | null> {
  const titleRe = /Daha fazla yerde (paylaş|ilan ver)/i;

  const candidates: Locator[] = [
    page
      .locator('[role="dialog"], [aria-modal="true"]')
      .filter({ hasText: titleRe })
      .first(),
    page
      .locator('[role="dialog"], [aria-modal="true"]')
      .filter({
        has: page.locator(`text=/Daha fazla yerde (paylaş|ilan ver)/i`),
      })
      .first(),
    page
      .locator("div")
      .filter({
        has: page.locator(`text=/Daha fazla yerde (paylaş|ilan ver)/i`),
      })
      .filter({
        has: page.locator(
          '[role="button"][aria-label="Paylaş"], [role="button"]:has-text("Paylaş")',
        ),
      })
      .first(),
  ];

  for (const c of candidates) {
    try {
      if ((await c.count()) === 0) continue;
      await c.waitFor({ state: "visible", timeout: 4000 });
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

async function getShareListScrollable(dialog: Locator): Promise<Locator> {
  // The selectable list is usually a scrollable div with max-height (e.g., 400px).
  const byStyle = dialog
    .locator('div[style*="max-height"]')
    .filter({ has: dialog.locator('[role="checkbox"]') })
    .first();

  try {
    if ((await byStyle.count()) > 0) return byStyle;
  } catch {
    // ignore
  }

  // Fallback: the dialog itself
  return dialog;
}

async function scrollDialogList(page: Page, scrollEl: Locator, dy: number) {
  await scrollEl
    .evaluate((el, delta) => {
      const e = el as HTMLElement;
      e.scrollBy({ top: Number(delta), left: 0, behavior: "auto" });
    }, dy)
    .catch(async () => {
      // Fallback: wheel on page (best-effort)
      await page.mouse.wheel(0, dy).catch(() => {});
    });
}

async function isScrollAtBottom(scrollEl: Locator): Promise<boolean> {
  return await scrollEl
    .evaluate((el) => {
      const e = el as HTMLElement;
      return Math.ceil(e.scrollTop + e.clientHeight) >= e.scrollHeight - 2;
    })
    .catch(() => true);
}

async function selectUpToNewGroupsInDialog(
  page: Page,
  dialog: Locator,
  already: Set<string>,
  maxToSelect: number,
): Promise<number> {
  const getCheckboxName = async (cb: Locator): Promise<string | null> => {
    const txt = await cb.innerText().catch(() => "");
    const name = extractFirstLine(txt);
    return name ? normalizeComparableText(name) : null;
  };

  const findCheckboxByName = async (
    normalizedName: string,
  ): Promise<Locator | null> => {
    const count = await dialog.locator('[role="checkbox"]').count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = dialog.locator('[role="checkbox"]').nth(i);
      const candidateName = await getCheckboxName(candidate);
      if (candidateName === normalizedName) return candidate;
    }
    return null;
  };

  const waitUntilGroupChecked = async (
    primary: Locator,
    normalizedName: string,
    attempts = 5,
    delayMs = 70,
  ): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      const directState = await primary
        .getAttribute("aria-checked")
        .catch(() => null);
      if (directState === "true") return true;

      if (i >= 1) {
        const target = await findCheckboxByName(normalizedName);
        if (target) {
          const state = await target.getAttribute("aria-checked").catch(() => null);
          if (state === "true") return true;
        }
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  };

  const scrollEl = await getShareListScrollable(dialog);

  // Ensure we're at the top so we can discover pre-checked items.
  await scrollEl
    .evaluate((el) => {
      const e = el as HTMLElement;
      e.scrollTop = 0;
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 80));

  // Seed the set with any currently-checked groups (these are already selected/shared in UI).
  const seedCount = await dialog
    .locator('[role="checkbox"][aria-checked="true"]')
    .count()
    .catch(() => 0);
  for (let i = 0; i < seedCount; i++) {
    const cb = dialog.locator('[role="checkbox"][aria-checked="true"]').nth(i);
    const name = await getCheckboxName(cb);
    if (name) already.add(name);
  }

  let selected = 0;
  let scrollStepsWithoutProgress = 0;

  for (let step = 0; step < 80 && selected < maxToSelect; step++) {
    const cbCount = await dialog
      .locator('[role="checkbox"]')
      .count()
      .catch(() => 0);

    let progressed = false;
    for (let i = 0; i < cbCount && selected < maxToSelect; i++) {
      const cb = dialog.locator('[role="checkbox"]').nth(i);
      const checked = await cb.getAttribute("aria-checked").catch(() => null);
      if (checked === "true") {
        const name = await getCheckboxName(cb);
        if (name) already.add(name);
        continue;
      }

      const name = await getCheckboxName(cb);
      if (!name) continue;
      if (already.has(name)) continue;

      await cb.scrollIntoViewIfNeeded().catch(() => {});
      await randomDelay(20, 45);
      await cb.click({ timeout: 5000 }).catch(() => {});

      if (!(await waitUntilGroupChecked(cb, name))) {
        const freshCb = await findCheckboxByName(name);
        if (freshCb) {
          await freshCb.scrollIntoViewIfNeeded().catch(() => {});
          await randomDelay(20, 45);
          await freshCb.click({ timeout: 5000, force: true }).catch(() => {});
          if (!(await waitUntilGroupChecked(freshCb, name, 6, 85))) continue;
        } else {
          continue;
        }
      }

      already.add(name);
      selected++;
      progressed = true;
    }

    if (progressed) {
      scrollStepsWithoutProgress = 0;
      continue;
    }

    scrollStepsWithoutProgress++;
    const atBottom = await isScrollAtBottom(scrollEl);
    if (atBottom || scrollStepsWithoutProgress >= 6) break;

    await scrollDialogList(page, scrollEl, 900);
    await new Promise((r) => setTimeout(r, 110));
  }

  return selected;
}

async function clickPaylasAndWait(page: Page, dialog: Locator) {
  const paylasCandidates: Locator[] = [
    // Accessible role name may include count like "Paylaş (20)"
    dialog.getByRole("button", { name: /^Paylaş/i }).first(),
    dialog.locator('[role="button"][aria-label*="Paylaş" i]').first(),
    dialog
      .locator('button, div[role="button"], span[role="button"]')
      .filter({ hasText: /^Paylaş/i })
      .first(),
    // Some FB UIs render action buttons in a portal; last resort.
    page.getByRole("button", { name: /^Paylaş/i }).last(),
  ];

  let paylas: Locator | null = null;
  for (const cand of paylasCandidates) {
    try {
      if ((await cand.count()) === 0) continue;
      if (await cand.isVisible({ timeout: 1500 })) {
        paylas = cand;
        break;
      }
    } catch {
      // try next
    }
  }
  if (!paylas) throw new Error('"Paylaş" butonu bulunamadı');

  await paylas.waitFor({ state: "visible", timeout: 20000 });
  await paylas.scrollIntoViewIfNeeded().catch(() => {});

  const isEffectivelyDisabled = async (el: Locator) => {
    return await el
      .evaluate((node) => {
        const n = node as any;
        const ariaDisabled =
          String(n?.getAttribute?.("aria-disabled") ?? "") === "true";
        const disabledProp = Boolean(n?.disabled);
        const ancestor = (n as HTMLElement | null)?.closest?.(
          '[aria-disabled="true"]',
        );
        return Boolean(ariaDisabled || disabledProp || ancestor);
      })
      .catch(() => false);
  };

  // Wait to be enabled
  for (let i = 0; i < 60; i++) {
    const disabled = await isEffectivelyDisabled(paylas);
    if (!disabled) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (await isEffectivelyDisabled(paylas)) {
    throw new Error(
      '"Paylaş" butonu disabled görünüyor (seçim sonrası aktifleşmedi).',
    );
  }

  await new Promise((r) => setTimeout(r, humanActionDelay()));
  await paylas.click();

  // Wait for either dialog to close or a publish confirmation.
  await Promise.race([
    dialog.waitFor({ state: "hidden", timeout: 25000 }).catch(() => {}),
    page
      .locator('[role="dialog"], [aria-modal="true"]')
      .filter({ hasText: /İlan yayınlandı/i })
      .first()
      .waitFor({ state: "visible", timeout: 25000 })
      .catch(() => {}),
  ]);

  // “İlan yayınlandı” dialog can show up; close it.
  const published = page
    .locator('[role="dialog"], [aria-modal="true"]')
    .filter({ hasText: /İlan yayınlandı/i })
    .first();
  const publishedVisible = await published
    .isVisible({ timeout: 1800 })
    .catch(() => false);
  if (!publishedVisible) return;

  try {
    const closeBtn = published
      .locator('[aria-label="Kapat"][role="button"]')
      .first();
    await closeBtn.waitFor({ state: "visible", timeout: 8000 });
    await new Promise((r) => setTimeout(r, humanActionDelay()));
    await closeBtn.click();
    await published
      .waitFor({ state: "hidden", timeout: 20000 })
      .catch(() => {});
  } catch {
    // ignore; sometimes it doesn't appear
  }
}

async function tryOpenMorePlacesFromPostMenu(
  page: Page,
  listingTitle: string,
): Promise<boolean> {
  const titleRe = listingTitle?.trim()
    ? new RegExp(escapeRegExp(listingTitle.trim()), "i")
    : null;

  // IMPORTANT: scope menu clicks to the *foreground post dialog* (Gönderisi),
  // otherwise we can click 3-dots on background posts.
  let root: Locator | null = null;
  if (titleRe) {
    const dialogByTitle = page
      .locator('[role="dialog"], [aria-modal="true"]')
      .filter({ hasText: /Gönderisi/i })
      .filter({
        has: page.locator("a, div, span").filter({ hasText: titleRe }),
      })
      .first();
    try {
      await dialogByTitle.waitFor({ state: "visible", timeout: 4000 });
      root = dialogByTitle;
    } catch {
      // ignore
    }
  }
  if (!root) {
    const anyPostDialog = page
      .locator('[role="dialog"], [aria-modal="true"]')
      .filter({ hasText: /Gönderisi/i })
      .first();
    try {
      await anyPostDialog.waitFor({ state: "visible", timeout: 3000 });
      root = anyPostDialog;
    } catch {
      root = null;
    }
  }

  if (!root) return false;

  const menuBtn = root
    .locator('[aria-label="Bu gönderi için eylemler"][role="button"]')
    .first()
    .or(root.locator('[aria-label="Bu gönderi için eylemler"]').first());
  try {
    await menuBtn.waitFor({ state: "visible", timeout: 8000 });
    await randomDelay(50, 120);
    await menuBtn.click();
  } catch {
    return false;
  }

  const item = page
    .locator('[role="menuitem"]')
    .filter({ hasText: /Daha fazla yerde ilan ver/i })
    .first();
  try {
    await item.waitFor({ state: "visible", timeout: 8000 });
    await randomDelay(50, 120);
    await item.click();
    return true;
  } catch {
    // try escape menu
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}

async function tryOpenMorePlacesFromYourPosts(
  page: Page,
  groupUrl: string,
  listingTitle: string,
): Promise<boolean> {
  await page.goto(groupUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("domcontentloaded");
  await new Promise((r) => setTimeout(r, 1200));

  const yourPostsTab = page
    .getByRole("tab", { name: /Senin Ürünlerin/i })
    .first()
    .or(page.locator("#yoursaleposts").first());
  try {
    await yourPostsTab.waitFor({ state: "visible", timeout: 15000 });
    await new Promise((r) => setTimeout(r, humanActionDelay()));
    await yourPostsTab.click();
  } catch {
    // if it fails, still continue; sometimes already on tab
  }

  await new Promise((r) => setTimeout(r, 1500));

  const titleRe = new RegExp(escapeRegExp(listingTitle), "i");
  const listingLink = page.locator("a").filter({ hasText: titleRe }).first();
  if ((await listingLink.count().catch(() => 0)) === 0) return false;

  // Find a nearby “Daha fazla yerde ilan ver” button within the same card/row.
  const row = listingLink.locator(
    'xpath=ancestor::div[.//div[@role="button" and @aria-label="Daha fazla yerde ilan ver"]][1]',
  );
  const btn = row
    .locator('[role="button"][aria-label="Daha fazla yerde ilan ver"]')
    .first();
  try {
    await btn.waitFor({ state: "visible", timeout: 15000 });
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await new Promise((r) => setTimeout(r, humanActionDelay()));
    await btn.click();
    return true;
  } catch {
    return false;
  }
}

async function shareToMoreGroupsUntilExhausted(
  page: Page,
  opts: {
    groupUrl: string;
    listingTitle: string;
    maxPerBatch: number;
    maxTotalGroups: number;
  },
) {
  const already = new Set<string>();
  let marketplaceSelectionHandled = false;
  let totalSelected = 0;

  // Give FB a short moment to finish the transition into the share dialog.
  await randomDelay(350, 550);

  // If the dialog doesn't exist, we do nothing (some accounts/flows may skip it).
  let dialog = await getMorePlacesDialog(page);
  if (!dialog) return;

  for (let batch = 0; batch < 80; batch++) {
    const remaining = opts.maxTotalGroups - totalSelected;
    if (remaining <= 0) {
      console.log(
        `✅ Grup limiti doldu (${opts.maxTotalGroups}). Sonraki ilana geçiliyor...`,
      );
      return;
    }

    dialog = (await getMorePlacesDialog(page)) ?? dialog;
    try {
      await dialog.waitFor({ state: "visible", timeout: 15000 });
    } catch {
      dialog = await getMorePlacesDialog(page);
      if (!dialog) return;
    }

    // Marketplace only needs to be handled once for this posting flow.
    if (!marketplaceSelectionHandled) {
      await ensureMarketplaceSelected(page, dialog);
      marketplaceSelectionHandled = true;
    }

    const picked = await selectUpToNewGroupsInDialog(
      page,
      dialog,
      already,
      Math.min(opts.maxPerBatch, remaining),
    );

    if (picked <= 0) {
      // nothing new found; close and stop
      const closeBtn = dialog
        .locator('[aria-label="Kapat"][role="button"]')
        .first();
      if ((await closeBtn.count().catch(() => 0)) > 0) {
        await new Promise((r) => setTimeout(r, humanActionDelay()));
        await closeBtn.click().catch(() => {});
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
      return;
    }

    await clickPaylasAndWait(page, dialog);
    totalSelected += picked;

    if (totalSelected >= opts.maxTotalGroups) {
      console.log(
        `✅ Bu ilan için toplam ${totalSelected} grup paylaşıldı. Sonraki ilana geçiliyor...`,
      );
      return;
    }

    // Re-open only from the current post's 3-dots menu.
    // If FB no longer offers "Daha fazla yerde ilan ver", we consider the job done.
    const openedFromMenu = await tryOpenMorePlacesFromPostMenu(
      page,
      opts.listingTitle,
    );
    if (openedFromMenu) {
      await randomDelay(180, 320);
      continue;
    }

    // If we can't reopen from the same post menu, sharing is exhausted for this run.
    return;
  }
}

export async function runFbMarketplace(
  payload: any,
  profilesDir: string,
  downloadsDir: string,
  chromeProfilePath?: string,
  fbCredentials?: FbCredentials | null,
  profileKey?: string,
) {
  console.log("FbMarketplace çalıştırılıyor...");
  console.log("payload:", payload);

  const key = profileKey ? safeKey(profileKey) : "default";

  const credsToRun = resolveCredentialsToRun(
    payload,
    fbCredentials ?? null,
    key,
  );
  const postsToRun = resolvePostsToRun(payload);
  if (postsToRun.length === 0) {
    throw new Error(
      "Payload içinde çalıştırılacak post bulunamadı (payload.posts veya payload.post).",
    );
  }
  if (credsToRun.length === 0) {
    throw new Error(
      "Payload içinde çalıştırılacak Facebook hesabı bulunamadı (payload.selectedFacebookCredentials / payload.facebookCredentials + facebookCredentialIds / fbCredentials).",
    );
  }

  const logs: string[] = [];
  const screenshots: string[] = [];

  for (let a = 0; a < credsToRun.length; a++) {
    const cred = credsToRun[a]!;
    const accountKey = safeKey(cred.id || `acc_${a + 1}`);
    const labelPart = cred.label ? ` ${cred.label}` : "";
    const screenshotPrefix =
      credsToRun.length > 1 ? `${key}_${accountKey}` : `${key}`;

    console.log(
      `👤 Hesap (${a + 1}/${credsToRun.length}) başlıyor: ${cred.id}${labelPart}`,
    );

    const effectiveChromeProfilePath =
      chromeProfilePath && credsToRun.length === 1
        ? chromeProfilePath
        : undefined;
    const profilePath =
      effectiveChromeProfilePath ??
      path.join(profilesDir, `facebook_${key}_${accountKey}`);
    if (!effectiveChromeProfilePath) {
      await fs.promises.mkdir(profilePath, { recursive: true });
    } else {
      console.log("🖥️  Chrome profili kullanılıyor:", profilePath);
    }

    console.log("🖥️  Chrome başlatılıyor (pencere açılacak)...");
    const ctx = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: { width: 1366, height: 768 },
      userAgent: REALISTIC_USER_AGENT,
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      args: STEALTH_LAUNCH_ARGS,
      ignoreDefaultArgs: ["--enable-automation"],
      ...(effectiveChromeProfilePath ? { channel: "chrome" as const } : {}),
    });

    try {
      await ctx.addInitScript(STEALTH_INIT_SCRIPT);
      const page = await ctx.newPage();
      console.log("✅ Chrome açıldı (stealth ayarları uygulandı).");

      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame() && frame.url() !== "about:blank") {
          console.log("📍 Gidilen adres:", frame.url());
        }
      });

      console.log("🔐 Facebook oturumu kontrol ediliyor...");
      await ensureLoggedIn(
        page,
        {
          email: cred.email,
          password: cred.password,
        },
        cred.label,
      );
      await ensureCorrectFacebookAccount(page, cred.label, {
        email: cred.email,
        password: cred.password,
      });

      for (let i = 0; i < postsToRun.length; i++) {
        const post = postsToRun[i] ?? {};
        const postId = typeof post?.id === "string" ? post.id : `idx_${i + 1}`;
        const postKey = safeKey(postId);

        console.log(
          `📝 Post (${i + 1}/${postsToRun.length}) başlıyor:`,
          String(post?.title ?? postId),
        );

        const payloadForPost = { ...(payload ?? {}), post };

        try {
          await randomDelay(120, 360);
          await runGroupSellFlow(page, payloadForPost, {
            email: cred.email,
            password: cred.password,
          });

          const shotCreatePath = path.join(
            downloadsDir,
            `group_sell_${screenshotPrefix}_${postKey}.png`,
          );
          await fs.promises.mkdir(path.dirname(shotCreatePath), {
            recursive: true,
          });
          await page
            .screenshot({ path: shotCreatePath, fullPage: true })
            .catch(() => {});

          const shotPath = path.join(
            downloadsDir,
            `last_marketplace_${screenshotPrefix}_${postKey}.png`,
          );
          await fs.promises.mkdir(path.dirname(shotPath), { recursive: true });
          await page.screenshot({ path: shotPath, fullPage: true });

          console.log("📸 Ekran görüntüsü alındı:", shotPath);
          screenshots.push(shotCreatePath, shotPath);
          logs.push(`[${cred.id}][${postId}] OK`);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          console.error("❌ Post hatası:", cred.id, postId, msg);
          if (e?.stack) console.error(e.stack);
          logs.push(`[${cred.id}][${postId}] ERROR: ${msg}`);
          // Continue with next post
        }
      }
    } finally {
      await ctx.close().catch(() => {});
      console.log("🖥️  Chrome kapatıldı.");
    }
  }

  return {
    screenshots: screenshots.filter(Boolean),
    log: logs.length > 0 ? logs.join("\n") : "No posts executed",
  };
}
