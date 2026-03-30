import "dotenv/config";
import fs from "fs";
import os from "os";
import { postJSON } from "./api.js";
import { loadConfig, saveConfig } from "./config.js";
import {
  getFbCredentials,
  getFbCredentialsForId,
  loadFbCredentials,
} from "./credentials.js";
import { getFingerprint } from "./device.js";
import { resolveMediaFilePaths } from "./media.js";
import { runFbMarketplace } from "./runners/fbMarketplace.js";

type PairResp = { agentId: string; token: string };

async function prompt(question: string) {
  process.stdout.write(question);

  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  return await new Promise<string>((resolve) => {
    let buf = "";
    const onData = (chunk: string) => {
      buf += chunk;
      if (buf.includes("\n")) {
        process.stdin.off("data", onData);
        resolve(buf.trim());
      }
    };
    process.stdin.on("data", onData);
  });
}

async function ensurePaired(cfg: ReturnType<typeof loadConfig>) {
  if (cfg.agentId && cfg.token) return cfg;

  const code = await prompt("Pairing code gir: ");
  const fingerprint = getFingerprint();
  const pcName = os.hostname();
  const resp = await postJSON<PairResp>(`${cfg.apiBase}/agent/pair`, {
    code,
    fingerprint,
    pcName,
  });

  cfg.agentId = resp.agentId;
  cfg.token = resp.token;
  saveConfig(cfg);
  console.log("✅ Paired:", resp.agentId);
  return cfg;
}

async function heartbeat(
  cfg: any,
  status: "online" | "busy" | "error" = "online",
) {
  await postJSON(`${cfg.apiBase}/agent/heartbeat`, {
    agentId: cfg.agentId,
    token: cfg.token,
    status,
  });
}

async function getNextJob(cfg: any) {
  console.log("Yeni job aranıyor...");
  return postJSON<any>(`${cfg.apiBase}/agent/jobs/next`, {
    agentId: cfg.agentId,
    token: cfg.token,
  });
}

async function finishJob(
  cfg: any,
  jobId: string,
  ok: boolean,
  logText: string,
  screenshots: string[] = [],
) {
  console.log("Job tamamlandı...");
  // Şimdilik screenshot path gönderiyoruz; prod’da bunları storage’a upload edip URL göndereceğiz.
  await postJSON(`${cfg.apiBase}/agent/jobs/${jobId}/finish`, {
    agentId: cfg.agentId,
    token: cfg.token,
    ok,
    logText,
    screenshots,
  });
}

async function main() {
  let cfg = loadConfig();
  await fs.promises.mkdir(cfg.downloadsDir, { recursive: true });
  await fs.promises.mkdir(cfg.profilesDir, { recursive: true });

  cfg = await ensurePaired(cfg);

  while (true) {
    try {
      await heartbeat(cfg, "online");

      const job = await getNextJob(cfg);
      if (!job) {
        await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
        continue;
      }

      await heartbeat(cfg, "busy");

      let ok = true;
      let logText = "";
      let screenshots: string[] = [];

      try {
        if (job.type === "FB_MARKETPLACE_POST") {
          let payload: any = job.payloadJson;
          if (typeof payload === "string") {
            try {
              payload = JSON.parse(payload);
            } catch {
              // keep as-is
            }
          }

          // Yeni akış: Frontend sadece dosya isimlerini gönderebilir. Agent bunları cfg.mediaDir altında gerçek path'e çevirir.
          // Not: multi-post payload'larda her post için ayrı resolve yapılmalı.
          const posts = Array.isArray(payload?.posts)
            ? (payload.posts as any[])
            : payload?.post
              ? [payload.post]
              : [];

          const mediaIssues: string[] = [];
          for (const p of posts) {
            const mp = p?.marketplacePayload;
            const rawMedia =
              mp?.mediaFilePaths ??
              mp?.mediaFileNames ??
              mp?.imageFilePaths ??
              mp?.imageFileNames;
            if (!mp || !rawMedia) continue;

            const { resolved, missing, invalid } = resolveMediaFilePaths(
              rawMedia,
              cfg.mediaDir,
            );
            mp.mediaFilePaths = resolved;
            // Back-compat with payloads using imageFilePaths/imageFileNames keys
            mp.imageFilePaths = resolved;

            if (missing.length > 0 || invalid.length > 0) {
              const postTag = p?.title
                ? `Post "${String(p.title)}"`
                : p?.id
                  ? `Post ${String(p.id)}`
                  : "Post";

              if (missing.length > 0) {
                mediaIssues.push(
                  `${postTag} -> Bulunamayan medya dosyaları: ${missing.join(", ")}`,
                );
              }
              if (invalid.length > 0) {
                mediaIssues.push(
                  `${postTag} -> Geçersiz medya girdileri (path traversal vs): ${invalid.join(", ")}`,
                );
              }
            }
          }

          if (mediaIssues.length > 0) {
            ok = false;
            if (!cfg.mediaDir) {
              mediaIssues.push(
                "config.json içinde mediaDir tanımlı değil (dosya isimlerini resolve etmek için gerekli).",
              );
            }
            logText = mediaIssues.join("\n");
          }

          if (!ok) {
            // medya dosyaları eksik/invalid ise hiç çalıştırmayalım
            throw new Error(logText || "Invalid media payload");
          }

          const ids = Array.isArray(payload?.facebookCredentialIds)
            ? (payload.facebookCredentialIds as string[])
            : [];

          if (ids.length > 0) {
            const logs: string[] = [];
            const shots: string[] = [];

            // Yeni akış: payload içindeki hazır facebookCredentials listesinden login oluruz.
            const embeddedCreds = Array.isArray(payload?.facebookCredentials)
              ? (payload.facebookCredentials as any[])
              : [];

            const credsToUse = embeddedCreds
              .filter((c) => c && typeof c.id === "string" && ids.includes(c.id))
              .map((c) => ({
                id: String(c.id),
                email: String(c.email ?? ""),
                password: String(c.password ?? ""),
                label: c.label ? String(c.label) : undefined,
              }))
              .filter((c) => c.email.length > 0 && c.password.length > 0);

            const groups = Array.isArray(payload?.facebookGroups)
              ? (payload.facebookGroups as any[])
              : [];
            const groupIds = Array.isArray(payload?.facebookGroupIds)
              ? (payload.facebookGroupIds as string[])
              : [];
            const groupsToUse = groups.filter(
              (g) => g && typeof g.id === "string" && groupIds.includes(g.id),
            );

            if (payload?.post) {
              console.log("📝 Post hazır:", String(payload.post?.title ?? ""));
            }
            if (groupsToUse.length > 0) {
              console.log(`👥 Seçilen grup sayısı: ${groupsToUse.length}`);
            }

            // Runner'lar ileride direkt kullanabilsin diye seçili listeleri payload'a da ekleyelim.
            payload.selectedFacebookGroups = groupsToUse;

            const finalCredsToUse =
              credsToUse.length > 0
                ? credsToUse
                : await Promise.all(
                    ids.map(async (facebookCredentialId) => {
                      // Geriye dönük destek: embedded credential yoksa API'den çek.
                      const cred = await getFbCredentialsForId(
                        cfg,
                        facebookCredentialId,
                      );
                      if (!cred) return null;
                      return {
                        id: facebookCredentialId,
                        email: cred.email,
                        password: cred.password,
                        label: undefined as string | undefined,
                      };
                    }),
                  ).then((arr) => arr.filter(Boolean) as any[]);

            if (finalCredsToUse.length === 0) {
              ok = false;
              logText =
                "Çalıştırılacak Facebook credential bulunamadı (payload.facebookCredentials veya API fallback).";
            } else {
              if (cfg.chromeProfilePath && finalCredsToUse.length > 1) {
                console.log(
                  "⚠️  Birden fazla hesap seçildiği için chromeProfilePath kullanılmayacak (hesaplar ayrı profilde çalışacak).",
                );
              }

              const chromeProfilePath =
                finalCredsToUse.length === 1 ? cfg.chromeProfilePath : undefined;

              // Çoklu hesap: runner kendi içinde hesapları sırayla çalıştırır ve her hesap için ayrı Chrome oturumu açar.
              payload.selectedFacebookCredentials = finalCredsToUse;
              payload.facebookCredentialIds = finalCredsToUse.map((c) => c.id);

              const res = await runFbMarketplace(
                payload,
                cfg.profilesDir,
                cfg.downloadsDir,
                chromeProfilePath,
                null,
                "batch",
              );
              logs.push(res.log);
              shots.push(...(res.screenshots ?? []));

              logText = logs.join("\n");
              screenshots = shots;
            }

          } else {
            await loadFbCredentials(cfg);
            const res = await runFbMarketplace(
              payload,
              cfg.profilesDir,
              cfg.downloadsDir,
              cfg.chromeProfilePath,
              getFbCredentials(),
              "default",
            );
            logText = res.log;
            screenshots = res.screenshots;
          }
        } else {
          logText = `Unsupported job type: ${job.type}`;
          ok = false;
        }
      } catch (e: any) {
        ok = false;
        logText = String(e?.message ?? e);
        console.error("Job hatası:", logText);
        if (e?.stack) console.error(e.stack);
      }

      await finishJob(cfg, job.id, ok, logText, screenshots);
      await heartbeat(cfg, ok ? "online" : "error");
    } catch (e: any) {
      console.error("Loop error:", e?.message ?? e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main();
