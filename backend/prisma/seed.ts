import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

// Stable dev fixture: the Google account already used to exercise the OAuth
// login flow in this environment. Sender.email is a separate "from" identity
// owned by that user, not tied to their login email.
const DEV_USER_EMAIL = "manviraghu357@gmail.com";

const DEV_SENDER = {
  email: "oliver.brown@domain.io",
  displayName: "Oliver Brown",
};

async function main() {
  const user = await prisma.user.findUnique({ where: { email: DEV_USER_EMAIL } });
  if (!user) {
    throw new Error(
      `Seed target user not found (email: ${DEV_USER_EMAIL}). Log in with Google once in this environment before seeding.`,
    );
  }

  // Upsert on the (userId, email) unique constraint makes this safe to re-run.
  const sender = await prisma.sender.upsert({
    where: { userId_email: { userId: user.id, email: DEV_SENDER.email } },
    update: { displayName: DEV_SENDER.displayName },
    create: { userId: user.id, email: DEV_SENDER.email, displayName: DEV_SENDER.displayName },
  });

  console.log(`Seeded sender "${sender.email}" (${sender.id}) for user ${user.email} (${user.id})`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
