import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { canonicalize } from '../common/canonical-json';
import { UnauthenticatedError } from '../common/problem-details';
import { uuidv4 } from '../common/uuid';

/**
 * HS256 session tokens, signed and verified with `node:crypto` alone.
 *
 * **This is a development-grade session mechanism and it is not what a real
 * deployment should run.** A production instance federates to an OIDC provider:
 * the identity provider owns registration, password policy, MFA, revocation and
 * key rotation, none of which are implemented here and none of which should be.
 * `Principal` is the boundary where that swap happens -- everything downstream of
 * `AuthService.resolvePrincipal` consumes a `Principal` and knows nothing about
 * how it was established, so replacing this file with JWKS-based verification of
 * a provider's RS256 tokens changes nothing else in the service.
 *
 * What this does own, and would still own after that swap, is the verification
 * discipline:
 *
 *   - `alg` is pinned to HS256 before the signature is checked. Accepting the
 *     algorithm the token names is the classic JWT failure: `{"alg":"none"}` and
 *     the RS256-public-key-as-HMAC-secret confusion both come from trusting an
 *     attacker-supplied header field to select the verification routine.
 *   - The signature is compared in constant time, over bytes, after a length
 *     check.
 *   - `exp` and `iat` are both required and both checked. A token without an
 *     expiry is a permanent credential that looks like a session.
 *
 * Written rather than taking `jsonwebtoken` because HS256 sign and verify is
 * `createHmac` plus base64url, the library's configuration surface is where most
 * of its CVEs have lived, and the parts that are genuinely hard -- key rotation,
 * JWKS fetching, revocation -- are the parts we are explicitly not doing.
 */

/** Only HS256. A token naming anything else, `none` included, is rejected unread. */
const ALGORITHM = 'HS256';

/**
 * Tolerance for `iat` only, never for `exp`.
 *
 * A token issued a moment in the future is a clock difference between two of our
 * own processes. A token that expired a moment ago is expired, and extending it
 * by "just a little" is how a session lifetime becomes a suggestion.
 */
const CLOCK_SKEW_SECONDS = 60;

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface SessionClaims {
  /** `app_user.id`. */
  sub: string;
  /** Tenant the session is scoped to. Confirmed against the database on every request. */
  tid: string;
  iat: number;
  exp: number;
  /** Recorded in the audit event for the sign-in, so a later action can be tied to a session. */
  jti: string;
  /**
   * Present, and only ever `true`, on a session minted by `POST /v1/auth/demo`.
   *
   * It rides in the signed payload rather than being re-derived from the user
   * id, because "this session came from the public demo" is a property of how
   * the credential was obtained and not of who it names. The same account
   * signing in through any other mechanism is not a demo session, and a lookup
   * table of demo user ids would say otherwise.
   *
   * Absent rather than `false` when it does not apply: the claim set is
   * canonicalised before signing, so an omitted member is one fewer byte in
   * every ordinary token, and `demo?: true` makes the only interesting value
   * the only representable one.
   */
  demo?: true;
}

export interface IssuedToken {
  token: string;
  claims: SessionClaims;
}

const claimsSchema = z.object({
  sub: z.uuid(),
  tid: z.uuid(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  jti: z.uuid(),
  demo: z.literal(true).optional(),
});

const headerSchema = z.object({
  alg: z.string(),
  typ: z.string().optional(),
});

export function signSession(
  secret: string,
  input: {
    userId: string;
    tenantId: string;
    ttlSeconds: number;
    issuedAt?: Date;
    /** Marks the session as a public read-only demo one. See `SessionClaims.demo`. */
    demo?: boolean;
  },
): IssuedToken {
  const issuedAt = Math.floor((input.issuedAt?.getTime() ?? Date.now()) / 1000);
  const claims: SessionClaims = {
    sub: input.userId,
    tid: input.tenantId,
    iat: issuedAt,
    exp: issuedAt + input.ttlSeconds,
    jti: uuidv4(),
    ...(input.demo === true ? { demo: true as const } : {}),
  };

  // Canonical JSON rather than `JSON.stringify`: the same claims always produce
  // the same bytes, which makes a token reproducible from its claims and keeps
  // one serialisation rule across the whole service.
  const signingInput = `${encode({ alg: ALGORITHM, typ: 'JWT' })}.${encode(claims)}`;

  return { token: `${signingInput}.${sign(secret, signingInput)}`, claims };
}

/**
 * Verify a token and return its claims.
 *
 * Every rejection is an `UnauthenticatedError`. The details differentiate expiry
 * from malformation because a client has to tell "refresh your session" from
 * "you are sending garbage", and neither tells an attacker anything it could not
 * determine by looking at the token it already holds.
 */
export function verifySession(secret: string, token: string): SessionClaims {
  const segments = token.split('.');
  const [headerPart, payloadPart, signaturePart] = segments;

  if (
    segments.length !== 3 ||
    headerPart === undefined ||
    payloadPart === undefined ||
    signaturePart === undefined ||
    !BASE64URL_SEGMENT.test(headerPart) ||
    !BASE64URL_SEGMENT.test(payloadPart) ||
    !BASE64URL_SEGMENT.test(signaturePart)
  ) {
    throw new UnauthenticatedError('The session token is not a well-formed JWT.');
  }

  const header = headerSchema.safeParse(decode(headerPart));
  if (!header.success) {
    throw new UnauthenticatedError('The session token has an unreadable header.');
  }
  // Checked before the signature so that an alg-confusion attempt never reaches
  // a verification routine chosen by the token itself.
  if (header.data.alg !== ALGORITHM) {
    throw new UnauthenticatedError(`Session tokens must be signed with ${ALGORITHM}.`);
  }

  const expected = Buffer.from(sign(secret, `${headerPart}.${payloadPart}`), 'base64url');
  const presented = Buffer.from(signaturePart, 'base64url');
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    throw new UnauthenticatedError('The session token signature does not verify.');
  }

  const claims = claimsSchema.safeParse(decode(payloadPart));
  if (!claims.success) {
    // The signature verified, so this is our own token carrying claims we no
    // longer understand -- a secret shared with an older or newer build.
    throw new UnauthenticatedError('The session token does not carry the expected claims.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.data.exp <= now) {
    throw new UnauthenticatedError('The session has expired.');
  }
  if (claims.data.iat > now + CLOCK_SKEW_SECONDS) {
    throw new UnauthenticatedError('The session token was issued in the future.');
  }

  return claims.data;
}

function sign(secret: string, signingInput: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(signingInput, 'utf8'))
    .digest('base64url');
}

function encode(value: unknown): string {
  return Buffer.from(canonicalize(value), 'utf8').toString('base64url');
}

/** Returns `unknown`; the caller parses it. A decode failure is an unparseable token. */
function decode(segment: string): unknown {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed;
  } catch {
    // Nothing recoverable and nothing to log: the input is a credential, and a
    // malformed one is reported to the caller by the schema check that follows.
    return undefined;
  }
}
