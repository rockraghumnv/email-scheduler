// Development-only: verifies the configured Ethereal SMTP account and sends
// one test message. Run with: npm run smtp:test
// Does not touch BullMQ, Postgres, or any HTTP route.
import { sendTestEmail, verifySmtpConnection } from "../services/smtp.service.js";

async function main() {
  console.log("Verifying SMTP connection...");
  const ok = await verifySmtpConnection();
  if (!ok) {
    console.error("SMTP verification failed — aborting. Check ETHEREAL_* values in backend/.env.");
    process.exitCode = 1;
    return;
  }

  console.log("Sending test email...");
  const result = await sendTestEmail();

  console.log("Message accepted, id:", result.messageId);
  console.log("Preview URL:", result.previewUrl || "(unavailable — is ETHEREAL_HOST a real Ethereal account?)");
}

main().catch((err) => {
  console.error("Failed to send test email:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
