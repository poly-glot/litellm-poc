import { generateKeyPairSync, randomUUID } from 'node:crypto';

import { signJwt } from './jwt.js';
import type { Jwk, RptPermission, RptSigner } from './types.js';

const RPT_TTL_SECONDS = 300;

export function createRptSigner(issuer: string): RptSigner {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk: Jwk = {
    ...(publicKey.export({ format: 'jwk' }) as Jwk),
    alg: 'RS256',
    kid,
    use: 'sig',
  };

  return {
    jwks: { keys: [jwk] },
    mint: (identity, handle) => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const permissions: RptPermission[] = [
        { rsname: `acme.client:${handle}`, scopes: ['access'] },
      ];

      const accessToken = signJwt(
        { alg: 'RS256', kid, typ: 'JWT' },
        {
          aud: 'client',
          exp: issuedAt + RPT_TTL_SECONDS,
          iat: issuedAt,
          iss: issuer,
          permissions,
          sub: identity,
        },
        privateKey,
      );

      return { access_token: accessToken, expires_in: RPT_TTL_SECONDS };
    },
  };
}
