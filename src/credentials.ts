import { getJSON } from "./api.js";
import type { AgentConfig } from "./config.js";

export type FbCredentials = { email: string; password: string };

const cachedById = new Map<string, FbCredentials>();
const DEFAULT_KEY = "__default__";

/**
 * Bot başında bir kez çağrılır; API'den Facebook e-posta/şifre alır ve global cache'e yazar.
 * Sonraki çağrılarda aynı değer döner, tekrar istek atılmaz.
 */
export async function loadFbCredentials(
  cfg: AgentConfig,
): Promise<FbCredentials | null> {
  if (cachedById.has(DEFAULT_KEY)) return cachedById.get(DEFAULT_KEY)!;

  try {
    const url = `${cfg.apiBase}/agent/credentials?agentId=${encodeURIComponent(
      cfg.agentId,
    )}&token=${encodeURIComponent(cfg.token)}`;
    const data = await getJSON<{ email?: string; password?: string }>(url);
    if (data?.email && data?.password) {
      const cred = { email: data.email, password: data.password };
      cachedById.set(DEFAULT_KEY, cred);
      console.log("✅ Facebook hesap bilgisi API'den alındı (bir kez).");
      return cred;
    }
  } catch (e) {
    console.warn("⚠️  Facebook hesap bilgisi alınamadı:", (e as Error)?.message);
  }
  return null;
}

/** Cache'teki credential'ı döndürür (önce loadFbCredentials çağrılmış olmalı). */
export function getFbCredentials(): FbCredentials | null {
  return cachedById.get(DEFAULT_KEY) ?? null;
}

/**
 * Yeni akış: Job payload'ındaki facebookCredentialId ile ilgili hesabın e-posta/şifresini al.
 * Aynı id için tekrar çağrılırsa cache'ten döner.
 */
export async function getFbCredentialsForId(
  cfg: AgentConfig,
  facebookCredentialId: string,
): Promise<FbCredentials | null> {
  if (cachedById.has(facebookCredentialId)) {
    return cachedById.get(facebookCredentialId)!;
  }

  try {
    const url = `${cfg.apiBase}/agent/credentials?agentId=${encodeURIComponent(
      cfg.agentId,
    )}&token=${encodeURIComponent(cfg.token)}&facebookCredentialId=${encodeURIComponent(
      facebookCredentialId,
    )}`;
    const data = await getJSON<{ email?: string; password?: string }>(url);
    if (data?.email && data?.password) {
      const cred = { email: data.email, password: data.password };
      cachedById.set(facebookCredentialId, cred);
      console.log("✅ Facebook hesap bilgisi alındı:", facebookCredentialId);
      return cred;
    }
  } catch (e) {
    console.warn(
      "⚠️  Facebook hesap bilgisi alınamadı:",
      facebookCredentialId,
      (e as Error)?.message,
    );
  }

  return null;
}
