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

function sortMediaFileNames(fileNames: string[]): string[] {
  return [...fileNames].sort((a, b) =>
    a.localeCompare(b, "tr-TR", {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
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

function normalizeMediaFileName(raw: string, mediaDir: string | undefined) {
  const normalized = normalizeMediaEntry(raw, mediaDir).replace(/[\\/]+$/g, "");
  const baseName = path.basename(normalized);
  if (!baseName || baseName === "." || baseName === "..") return "";
  return baseName;
}

function extractMediaNameFromValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const candidates = [
    record.name,
    record.fileName,
    record.filename,
    record.originalName,
    record.originalFilename,
    record.path,
    record.url,
    record.src,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function extractMediaEntriesFromArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const entries: string[] = [];
  for (const item of value) {
    const name = extractMediaNameFromValue(item);
    if (name) entries.push(name);
  }
  return entries;
}

function extractMediaEntryFromScalar(value: unknown): string[] {
  const name = extractMediaNameFromValue(value);
  return name ? [name] : [];
}

export function extractRequestedMediaEntries(
  post: any,
): { entries: string[]; sourceKey?: string } {
  const arrayCandidateKeys = [
    "imageFileNames",
    "images",
    "photos",
    "media",
    "mediaPaths",
    "photoFileNames",
    "mediaFileNames",
    "imageFilePaths",
    "mediaFilePaths",
    "imageNames",
    "photoNames",
    "selectedImages",
    "selectedImageNames",
    "selectedPhotos",
    "selectedPhotoNames",
    "selectedMedia",
    "files",
  ];
  const scalarCandidateKeys = [
    "coverImage",
    "coverImageFileName",
    "thumbnail",
    "thumbnailFileName",
    "mainPhoto",
    "mainPhotoFileName",
  ];

  const scopes = [post?.marketplacePayload, post].filter(Boolean) as Array<
    Record<string, unknown>
  >;

  for (const scope of scopes) {
    for (const key of arrayCandidateKeys) {
      const entries = extractMediaEntriesFromArray(scope[key]);
      if (entries.length > 0) return { entries, sourceKey: key };
    }
    for (const key of scalarCandidateKeys) {
      const entries = extractMediaEntryFromScalar(scope[key]);
      if (entries.length > 0) return { entries, sourceKey: key };
    }
  }

  return { entries: [] };
}

export function resolveMediaFilePaths(
  entries: unknown,
  mediaDir: string | undefined,
): { resolved: string[]; missing: string[]; invalid: string[]; folderTried?: string } {
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

export function resolveMediaFilePathsFromUuidFolder(
  folderUuid: unknown,
  entries: unknown,
  mediaDir: string | undefined,
): { resolved: string[]; missing: string[]; invalid: string[]; folderTried?: string } {
  const resolved: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  if (!mediaDir) {
    missing.push("mediaDir is not configured");
    return { resolved, missing, invalid };
  }

  const rawUuid = toNonEmptyString(folderUuid) ?? "";
  if (!rawUuid) {
    invalid.push(String(folderUuid));
    return { resolved, missing, invalid };
  }

  const folderPath = path.resolve(mediaDir, rawUuid);
  if (!startsWithPath(mediaDir, folderPath)) {
    invalid.push(rawUuid);
    return { resolved, missing, invalid };
  }

  try {
    const st = fs.statSync(folderPath);
    if (!st.isDirectory()) {
      missing.push(`UUID folder is not a directory: "${folderPath}"`);
      return { resolved, missing, invalid, folderTried: folderPath };
    }
  } catch {
    missing.push(`UUID folder not found under mediaDir for uuid="${rawUuid}"`);
    return { resolved, missing, invalid, folderTried: folderPath };
  }

  const arr = Array.isArray(entries) ? entries : [];

  let folderEntries: string[] = [];
  try {
    folderEntries = fs.readdirSync(folderPath);
  } catch (e: any) {
    missing.push(
      `Cannot read uuid folder "${folderPath}": ${String(e?.message ?? e)}`,
    );
    return { resolved, missing, invalid, folderTried: folderPath };
  }

  const imageFiles = sortMediaFileNames(
    folderEntries
    .filter((name) => typeof name === "string" && name.trim().length > 0)
      .filter((name) => isProbablyImageFile(name)),
  );

  if (imageFiles.length === 0) {
    missing.push(`No image files found under "${folderPath}"`);
    return { resolved, missing, invalid, folderTried: folderPath };
  }

  if (arr.length === 0) {
    for (const fileName of imageFiles) {
      const fullPath = path.resolve(folderPath, fileName);
      if (!startsWithPath(folderPath, fullPath)) {
        invalid.push(fileName);
        continue;
      }

      try {
        const st = fs.statSync(fullPath);
        if (!st.isFile()) {
          missing.push(fileName);
          continue;
        }
        resolved.push(fullPath);
      } catch {
        missing.push(fileName);
      }
    }

    return { resolved, missing, invalid, folderTried: folderPath };
  }

  const fileMap = new Map<string, string>();
  for (const fileName of imageFiles) {
    fileMap.set(fileName.toLocaleLowerCase("tr-TR"), fileName);
  }

  for (const raw of arr) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      invalid.push(String(raw));
      continue;
    }

    const requestedName = normalizeMediaFileName(raw, mediaDir);
    if (!requestedName) {
      invalid.push(String(raw));
      continue;
    }
    if (!isProbablyImageFile(requestedName)) {
      invalid.push(requestedName);
      continue;
    }

    const matched = fileMap.get(requestedName.toLocaleLowerCase("tr-TR"));
    if (!matched) {
      missing.push(requestedName);
      continue;
    }

    const fullPath = path.resolve(folderPath, matched);
    if (!startsWithPath(folderPath, fullPath)) {
      invalid.push(matched);
      continue;
    }

    try {
      const st = fs.statSync(fullPath);
      if (!st.isFile()) {
        missing.push(matched);
        continue;
      }
      resolved.push(fullPath);
    } catch {
      missing.push(matched);
    }
  }

  if (resolved.length === 0) {
    missing.push(`No matching payload image files found under "${folderPath}"`);
  }

  return { resolved, missing, invalid, folderTried: folderPath };
}

export function resolveMediaUuidFromPost(post: any): string | undefined {
  const candidates = [
    post?.uuid,
    post?.mediaUuid,
    post?.id,
    post?.marketplacePayload?.uuid,
    post?.marketplacePayload?.mediaUuid,
    post?.marketplacePayload?.postUuid,
    post?.marketplacePayload?.postId,
  ];

  for (const candidate of candidates) {
    const normalized = toNonEmptyString(candidate);
    if (normalized) return normalized;
  }

  return undefined;
}
