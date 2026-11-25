import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export const SESSION_COOKIE = '__githack_session';
export const HOST_SESSION_COOKIE = '__Host-githack_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function sessionCookieName(secure) {
  return secure ? HOST_SESSION_COOKIE : SESSION_COOKIE;
}

const SHORT_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });

  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    key.toString('hex'),
  ].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;

  const [algorithm, n, r, p, saltHex, hashHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;

  try {
    const expected = Buffer.from(hashHex, 'hex');
    const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });

    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export function newSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSessionToken(token) };
}

export function newInviteToken() {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashSessionToken(token) };
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 10) {
  const codes = [];

  for (let index = 0; index < count; index += 1) {
    const bytes = randomBytes(12);
    let raw = '';

    for (let i = 0; i < bytes.length; i += 1) {
      raw += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    }

    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }

  return codes;
}

export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code) {
  return createHash('sha256')
    .update(normalizeRecoveryCode(code))
    .digest('hex');
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function shortId(length = 8) {
  const bytes = randomBytes(length);
  let id = '';

  for (let i = 0; i < length; i += 1) {
    id += SHORT_ID_ALPHABET[bytes[i] % SHORT_ID_ALPHABET.length];
  }

  return id;
}

export function parseCookies(header) {
  const cookies = {};

  if (!header) return cookies;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }

  return cookies;
}

export function sessionCookie(token, { secure, maxAge = SESSION_TTL_SECONDS } = {}) {
  const parts = [
    `${sessionCookieName(secure)}=${token}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie({ secure } = {}) {
  return sessionCookie('', { secure, maxAge: 0 });
}

export function clearSessionCookies({ secure } = {}) {
  const cookies = [
    sessionCookie('', { secure, maxAge: 0 }),
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  ];

  if (secure) {
    cookies.push(
      `${HOST_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    );
  }

  return cookies;
}

export function isSafeRedirect(target, fallback = '/') {
  if (typeof target !== 'string') return fallback;
  if (!target.startsWith('/') || target.startsWith('//')) return fallback;
  if (/[\r\n]/.test(target)) return fallback;
  return target;
}

export function isUsername(value) {
  // Permissive validator for existing accounts and login.
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value || '');
}

export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'root',
  'system',
  'sysadmin',
  'superuser',
  'sudo',
  'daemon',
  'bin',
  'nobody',
  'guest',
  'support',
  'help',
  'security',
  'abuse',
  'postmaster',
  'hostmaster',
  'webmaster',
  'www',
  'api',
  'dashboard',
  'login',
  'logout',
  'register',
  'static',
  'cdn',
  'raw',
  'gist',
  'gl',
  'bb',
  'gt',
  'cb',
  's',
  'purge',
  'health',
  'status',
  'mail',
  'ftp',
  'ssh',
  'null',
  'undefined',
  'console',
  'test',
  'demo',
  'user',
  'users',
  'account',
  'accounts',
]);

export function isReservedUsername(value) {
  return RESERVED_USERNAMES.has(String(value || '').toLowerCase());
}

export function isValidNewUsername(value) {
  return /^[A-Za-z0-9_]{3,32}$/.test(value || '')
    && !isReservedUsername(value);
}

export function secretsMatch(left, right) {
  if (!left || !right) return false;

  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}
