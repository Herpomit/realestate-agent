import crypto from "crypto";
import os from "os";

export function getFingerprint() {
  const raw = [os.hostname(), os.platform(), os.arch()].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex");
}
