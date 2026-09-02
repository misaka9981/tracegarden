const [major, minor] = process.versions.node.split(".").map(Number);
const failures = [];
if (major !== 26 || minor !== 8) failures.push(`Node.js 26.8.x is required (found ${process.version})`);
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) failures.push("DATABASE_URL is required in production");
if (process.env.NODE_ENV === "production" && (!process.env.BETTER_AUTH_SECRET?.trim() || !process.env.BETTER_AUTH_URL?.trim())) failures.push("BETTER_AUTH_SECRET and BETTER_AUTH_URL are required in production");
if (process.env.NODE_ENV === "production" && !process.env.TIMELINE_CURSOR_SECRET?.trim()) failures.push("TIMELINE_CURSOR_SECRET is required in production");
const production = process.env.NODE_ENV === "production";
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI?.trim();
if (production && (!process.env.GOOGLE_CLIENT_ID?.trim() || !process.env.GOOGLE_CLIENT_SECRET?.trim() || !googleRedirectUri)) {
  failures.push("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI are required in production");
}
if (production && googleRedirectUri) {
  try {
    const url = new URL(googleRedirectUri);
    if (url.protocol !== "https:") failures.push("GOOGLE_REDIRECT_URI must be HTTPS in production");
    if (url.username || url.password) failures.push("GOOGLE_REDIRECT_URI must not include credentials");
    if (googleRedirectUri.includes("#")) failures.push("GOOGLE_REDIRECT_URI must not include a fragment");
  } catch {
    failures.push("GOOGLE_REDIRECT_URI must be an absolute HTTPS URL in production");
  }
}
if (process.env.NODE_ENV === "production" && (!process.env.TRACEGARDEN_BOOTSTRAP_ISSUER?.trim() || !process.env.TRACEGARDEN_BOOTSTRAP_SUBJECT?.trim())) {
  failures.push("TRACEGARDEN_BOOTSTRAP_ISSUER and TRACEGARDEN_BOOTSTRAP_SUBJECT are required in production");
}
const previewAccessFields = ["CLOUDFLARE_ACCESS_JWT_ISSUER", "CLOUDFLARE_ACCESS_JWT_AUDIENCE", "CLOUDFLARE_ACCESS_JWT_PUBLIC_KEY"];
if (process.env.NODE_ENV === "preview" && previewAccessFields.some((field) => !process.env[field]?.trim())) {
  failures.push("Preview requires CLOUDFLARE_ACCESS_JWT_ISSUER, CLOUDFLARE_ACCESS_JWT_AUDIENCE, and CLOUDFLARE_ACCESS_JWT_PUBLIC_KEY");
}
if (process.env.NODE_ENV === "preview" && process.env.CLOUDFLARE_ACCESS_JWT_ISSUER?.trim()) {
  try {
    if (new URL(process.env.CLOUDFLARE_ACCESS_JWT_ISSUER).protocol !== "https:") failures.push("CLOUDFLARE_ACCESS_JWT_ISSUER must be HTTPS in preview");
  } catch {
    failures.push("CLOUDFLARE_ACCESS_JWT_ISSUER must be HTTPS in preview");
  }
}
if (process.env.NODE_ENV === "production" && process.env.BETTER_AUTH_URL?.trim()) {
  try {
    if (new URL(process.env.BETTER_AUTH_URL).protocol !== "https:") failures.push("BETTER_AUTH_URL must be HTTPS in production");
  } catch {
    failures.push("BETTER_AUTH_URL must be HTTPS in production");
  }
}
if (process.env.DATABASE_MODE === "memory" && process.env.NODE_ENV !== "test") failures.push("DATABASE_MODE=memory is restricted to test runs");
if (process.env.DATABASE_URL?.startsWith("postgres://") || process.env.DATABASE_URL?.startsWith("postgresql://")) {
  console.log("DATABASE_URL is configured without printing its value");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`environment valid: Node.js ${process.version}`);
}
