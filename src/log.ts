// Logging hygiene (§7). The gateway NEVER logs raw join codes, host IPs/candidate
// URLs, or host tokens. Codes are hashed; bodies are never serialized.

import { createHash } from "node:crypto";

export function codeHash(code: string): string {
  return createHash("sha256").update(code.toUpperCase()).digest("hex").slice(0, 12);
}
