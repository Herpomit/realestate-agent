import fs from "fs";
import path from "path";

function startsWithPath(baseDir: string, fullPath: string) {
  const base = path.resolve(baseDir);
  const full = path.resolve(fullPath);
  if (process.platform === "win32") {
    const b = base.toLowerCase();
    const f = full.toLowerCase();
    return f === b || f.startsWith(b + path.sep);
  }
  return full === base || full.startsWith(base + path.sep);
}

function sanitizeFolderName(s: string): string {
  // Windows folder names cannot contain: \ / : * ? " < > |
  // Also avoid trailing dots/spaces (Windows strips them on disk).
  return (
    s
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      // Collapse whitespace for stability
      .replace(/\s+/g, " ")
      // Avoid trailing dots/spaces
      .replace(/[. ]+$/g, "")
  );
}

function isProbablyImageFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".heic",
    ".heif",
    ".bmp",
  ].includes(ext);
}

function normalizeMediaEntry(raw: string, mediaDir: string | undefined) {
  let s = raw.trim();

  // Accept file URLs that some frontends emit (e.g. file:///C:/shared-media/a.jpg)
  if (/^file:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = decodeURIComponent(u.pathname);
      if (process.platform === "win32" && s.startsWith("/")) s = s.slice(1);
    } catch {
      // keep original string if parsing fails
    }
  }

  // On Windows, a leading "/" is treated as absolute (root of current drive),
  // but frontend may accidentally send "/a.jpg". Prefer resolving under mediaDir.
  if (process.platform === "win32" && mediaDir && s.startsWith("/") && !s.startsWith("//")) {
    s = s.replace(/^\/+/, "");
  }

  // If frontend sends "shared-media/a.jpg" while mediaDir is ".../shared-media",
  // strip the redundant folder prefix.
  if (process.platform === "win32" && mediaDir) {
    const base = path.basename(path.resolve(mediaDir));
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]+`, "i");
    if (re.test(s)) s = s.replace(re, "");
  }

  return s;
}

export function resolveMediaFilePaths(
  entries: unknown,
  mediaDir: string | undefined,
): { resolved: string[]; missing: string[]; invalid: string[] } {
  const resolved: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  const arr = Array.isArray(entries) ? entries : [];
  for (const raw of arr) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      invalid.push(String(raw));
      continue;
    }

    const nameOrPath = normalizeMediaEntry(raw, mediaDir);
    let fullPath = nameOrPath;

    if (!path.isAbsolute(nameOrPath)) {
      if (!mediaDir) {
        missing.push(nameOrPath);
        continue;
      }
      fullPath = path.resolve(mediaDir, nameOrPath);
      if (!startsWithPath(mediaDir, fullPath)) {
        invalid.push(nameOrPath);
        continue;
      }
    }

    try {
      const st = fs.statSync(fullPath);
      if (!st.isFile()) {
        missing.push(nameOrPath);
        continue;
      }
      resolved.push(fullPath);
    } catch {
      missing.push(nameOrPath);
    }
  }

  return { resolved, missing, invalid };
}

export function listMediaFilesUnderTitleFolder(
  title: unknown,
  mediaDir: string | undefined,
): { resolved: string[]; missing: string[]; invalid: string[]; folderTried?: string } {
  const resolved: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  if (!mediaDir) {
    missing.push("mediaDir is not configured");
    return { resolved, missing, invalid };
  }

  const rawTitle = typeof title === "string" ? title.trim() : "";
  if (!rawTitle) {
    invalid.push(String(title));
    return { resolved, missing, invalid };
  }

  const candidates = Array.from(
    new Set([rawTitle, sanitizeFolderName(rawTitle)].filter(Boolean)),
  );

  for (const folderName of candidates) {
    const folderPath = path.resolve(mediaDir, folderName);
    if (!startsWithPath(mediaDir, folderPath)) {
      invalid.push(folderName);
      continue;
    }

    try {
      const st = fs.statSync(folderPath);
      if (!st.isDirectory()) continue;
    } catch {
      // try next candidate
      continue;
    }

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(folderPath);
    } catch (e: any) {
      missing.push(
        `Cannot read folder "${folderPath}": ${String(e?.message ?? e)}`,
      );
      return { resolved, missing, invalid, folderTried: folderPath };
    }

    const files = entries
      .filter((n) => typeof n === "string" && n.trim().length > 0)
      .filter((n) => isProbablyImageFile(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const f of files) {
      const full = path.resolve(folderPath, f);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) resolved.push(full);
      } catch {
        // ignore missing file
      }
    }

    if (resolved.length === 0) {
      missing.push(`No image files found under "${folderPath}"`);
    }

    return { resolved, missing, invalid, folderTried: folderPath };
  }

  missing.push(
    `Title folder not found under mediaDir for title="${rawTitle}" (tried: ${candidates.join(
      ", ",
    )})`,
  );
  return { resolved, missing, invalid };
}
