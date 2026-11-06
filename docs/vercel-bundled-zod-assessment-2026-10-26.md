# Vercel bundled Zod assessment - 26 October 2026

## Finding
- Installed @vercel/cli-config 0.2.6 exports a bundle identifying its embedded Zod as 4.1.11.
- The scoped dependency override resolves external Zod to 4.6.7 but does not replace this embedded copy.
- npm audit reported zero findings for the dependency tree; that result does not verify embedded code.

## Inspected call path
- HOST property image routes and the image manager use @vercel/blob.
- Blob includes an OIDC authentication path through @vercel/oidc.
- OIDC token refresh can call @vercel/cli-config to read local authentication configuration.
- The inspected Blob authentication resolver checks for an explicit read-write token before attempting OIDC; other branches can attempt OIDC.
- The exported bundle reads local JSON configuration through its bundled parser.

## Schema inspection
- Bundled auth and global configuration schema definitions were inspected.
- Their declared fields use scalar values, unions and nested objects; no constrained array appears in those inspected definitions.
- The reported oversized constrained-collection trigger was not identified in this inspected config path.
- Runtime authentication branch, all possible inputs and all bundled code paths were not exhaustively tested.
- This finding is not proof that the old embedded copy is safe or patched.

## Outstanding work
- Track an upstream release that updates or removes the embedded Zod copy.
- Reassess the effective package bundle and Blob authentication behavior before deployment.
- No provider request or credential-file read was performed during this source inspection.
- No deployment, environment-file change or package modification was made during this assessment.
