import { prisma } from "../lib/prisma.js";

export interface PublicSender {
  id: string;
  email: string;
  displayName: string | null;
}

interface SenderRecord {
  id: string;
  email: string;
  displayName: string | null;
}

function toPublicSender(sender: SenderRecord): PublicSender {
  return { id: sender.id, email: sender.email, displayName: sender.displayName };
}

export async function listSendersForUser(userId: string): Promise<PublicSender[]> {
  const senders = await prisma.sender.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return senders.map(toPublicSender);
}
