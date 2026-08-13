import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { google } from "googleapis";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { redisClient } from "../lib/redis.js";
import { ConflictError, HttpError, TooManyRequestsError, UnauthorizedError } from "../utils/errors.js";

const scrypt = promisify(scryptCallback);
const SCRYPT_KEYLEN = 64;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `${salt}:${derivedKey.toString("hex")}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) {
    return false;
  }
  const keyBuffer = Buffer.from(key, "hex");
  const derivedKey = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  if (derivedKey.length !== keyBuffer.length) {
    return false;
  }
  return timingSafeEqual(derivedKey, keyBuffer);
}

const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;

async function assertNotRateLimited(bucket: string): Promise<void> {
  const key = `auth:rate-limit:${bucket}`;
  const attempts = await redisClient.incr(key);
  if (attempts === 1) {
    await redisClient.expire(key, LOGIN_ATTEMPT_WINDOW_SECONDS);
  }
  if (attempts > LOGIN_ATTEMPT_LIMIT) {
    throw new TooManyRequestsError();
  }
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

function toPublicUser(user: UserRecord): PublicUser {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl };
}

export async function registerWithPassword(params: {
  email: string;
  password: string;
  name?: string | undefined;
}): Promise<PublicUser> {
  const email = params.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError("An account with this email already exists");
  }

  const passwordHash = await hashPassword(params.password);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: params.name ?? null,
    },
  });

  return toPublicUser(user);
}

export async function authenticateWithPassword(params: {
  email: string;
  password: string;
}): Promise<PublicUser> {
  const email = params.email.trim().toLowerCase();
  await assertNotRateLimited(email);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const valid = await verifyPassword(params.password, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError("Invalid email or password");
  }

  return toPublicUser(user);
}

export async function getUserById(id: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({ where: { id } });
  return user ? toPublicUser(user) : null;
}

function createGoogleOAuthClient() {
  return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL);
}

export function getGoogleAuthUrl(state: string): string {
  const client = createGoogleOAuthClient();
  return client.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    prompt: "select_account",
    state,
  });
}

interface GoogleProfile {
  googleId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

async function getGoogleProfileFromCode(code: string): Promise<GoogleProfile> {
  const client = createGoogleOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.id_token) {
    throw new HttpError(400, "Google did not return an ID token");
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw new HttpError(400, "Google profile is missing required fields");
  }
  if (!payload.email_verified) {
    throw new HttpError(400, "Google account email is not verified");
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? null,
    avatarUrl: payload.picture ?? null,
  };
}

export async function authenticateWithGoogle(code: string): Promise<PublicUser> {
  const profile = await getGoogleProfileFromCode(code);

  const existingByGoogleId = await prisma.user.findUnique({ where: { googleId: profile.googleId } });
  if (existingByGoogleId) {
    const updated = await prisma.user.update({
      where: { id: existingByGoogleId.id },
      data: { name: profile.name, avatarUrl: profile.avatarUrl },
    });
    return toPublicUser(updated);
  }

  // Google verifies email ownership, so it's safe to auto-link to an existing
  // password account that shares the same email instead of creating a duplicate.
  const existingByEmail = await prisma.user.findUnique({ where: { email: profile.email } });
  if (existingByEmail) {
    const linked = await prisma.user.update({
      where: { id: existingByEmail.id },
      data: {
        googleId: profile.googleId,
        name: existingByEmail.name ?? profile.name,
        avatarUrl: existingByEmail.avatarUrl ?? profile.avatarUrl,
      },
    });
    return toPublicUser(linked);
  }

  const created = await prisma.user.create({
    data: {
      email: profile.email,
      googleId: profile.googleId,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    },
  });

  return toPublicUser(created);
}
