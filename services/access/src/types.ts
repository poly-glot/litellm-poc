export interface Jwk {
  alg?: string;
  e?: string;
  kid?: string;
  kty?: string;
  n?: string;
  use?: string;
}

export interface Jwks {
  keys: Jwk[];
}

export interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

export interface RptPermission {
  rsname: string;
  scopes: string[];
}

export interface JwtClaims {
  aud?: string;
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  permissions?: RptPermission[];
  preferred_username?: string;
  sub?: string;
}

export interface DecodedJwt {
  claims: JwtClaims;
  header: JwtHeader;
  signature: Buffer;
  signingInput: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
}

export interface ErrorBody {
  error: string;
}

export interface ExchangeResult {
  body: ErrorBody | TokenResponse;
  status: number;
}

export interface ExchangeDeps {
  entitlements: ReadonlyMap<string, string>;
  issuerAllowlistPrefix: string;
  mintRpt: (identity: string, handle: string) => TokenResponse;
}

export interface RptSigner {
  jwks: Jwks;
  mint: (identity: string, handle: string) => TokenResponse;
}

export interface AccessServerConfig {
  issuerAllowlistPrefix: string;
  rptIssuer: string;
}
