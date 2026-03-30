import fs from "fs";
import path from "path";

export type AgentConfig = {
  apiBase: string;
  agentId: string;
  token: string;
  pollIntervalMs: number;
  downloadsDir: string;
  profilesDir: string;
  /**
   * Agent bilgisayarında sabit foto klasörü.
   * Frontend job payload'ına sadece dosya isimlerini (örn. "ilan1-1.jpg") koyar;
   * Agent bu klasörde dosyayı bulup upload eder.
   */
  mediaDir?: string;
  /** Opsiyonel: Kurulu Google Chrome'un kullandığı profil klasörü.
   *  Kullanmak için Chrome'u kapatıp bu klasörü kopyalayın:
   *  Örn. C:\Users\...\AppData\Local\Google\Chrome\User Data
   *  → profiles\facebook içine (Default, System Profile vb. burada olacak) */
  chromeProfilePath?: string;
};

const CONFIG_PATH = path.join(process.cwd(), "config.json");

export function loadConfig(): AgentConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as AgentConfig;
}

export function saveConfig(cfg: AgentConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}
