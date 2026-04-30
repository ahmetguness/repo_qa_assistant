import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for encryption");
  return createHash("sha256").update(secret).digest();
}

export function encrypt(text: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  // Format: iv:tag:encrypted
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
  // If it doesn't look encrypted (no colons), return as-is (backward compat)
  if (!encryptedText.includes(":")) return encryptedText;

  const key = getKey();
  const [ivHex, tagHex, encrypted] = encryptedText.split(":");
  if (!ivHex || !tagHex || !encrypted) return encryptedText;

  try {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    // If decryption fails, return as-is (might be unencrypted legacy data)
    return encryptedText;
  }
}
