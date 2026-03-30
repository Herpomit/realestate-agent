import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";

export async function downloadToFile(url: string, outPath: string) {
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const res = await fetch(url);
  if (!res.ok || !res.body)
    throw new Error(`Download failed ${res.status} ${url}`);

  const fileStream = fs.createWriteStream(outPath);
  // @ts-expect-error node fetch body is a web stream; in Node 20 it is compatible via Readable.fromWeb
  const nodeStream = (await import("stream")).Readable.fromWeb(res.body);

  await pipeline(nodeStream, fileStream);
  return outPath;
}

export function extFromUrl(url: string) {
  try {
    const u = new URL(url);
    const p = u.pathname;
    const idx = p.lastIndexOf(".");
    return idx >= 0 ? p.slice(idx) : "";
  } catch {
    return "";
  }
}
