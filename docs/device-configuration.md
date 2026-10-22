# Roku device and playlist configuration API

All routes use `/api/v1`. Responses are JSON except `GET /pair`, which serves the pairing form. Device errors use `{ "code", "message", "requestId" }`; validation errors also include `details` with field paths. Secrets and full playlist URLs are never returned.

## Credential meaning

`username` and `password` on the partner flow are the customer's **IPTV provider credentials**. They are not Delta account credentials and are not credentials for the partnership portal. The backend validates them only against active provider endpoints belonging to the partner code, encrypts them at rest, and does not return them to the Roku or web page after submission.

A no-partnership playlist is tied to a Delta license. The Roku can configure it after license activation; QR setup requires the Delta license code as proof of entitlement. The playlist URL is encrypted at rest. For Xtream-compatible URLs, the backend extracts the base URL and credentials and returns only that configuration to the Roku; the backend does not download or persist the M3U response. The Roku requests categories and content directly from the provider.

## 1. Direct Roku setup

### Register and obtain a QR/poll capability

`POST /api/v1/client/register` is idempotent for the device record. `installationId` must be `roku-` plus the uppercase MAC without separators. A still-valid pending pairing is returned again; an active device does not receive a new pairing capability.

```json
{
  "mac": "AA:BB:CC:DD:EE:FF",
  "installationId": "roku-AABBCCDDEEFF"
}
```

Pending response (`200`):

```json
{
  "deviceId": "device-uuid",
  "mac": "AA:BB:CC:DD:EE:FF",
  "installationId": "roku-AABBCCDDEEFF",
  "status": "awaiting_configuration",
  "configured": false,
  "activationId": null,
  "mode": null,
  "listName": null,
  "allowed": false,
  "code": "AWAITING_CONFIGURATION",
  "message": "Configure uma lista para continuar.",
  "expiresAt": null,
  "pairing": {
    "url": "https://tv.example/pair#<temporary-pair-token>",
    "expiresAt": "2026-10-17T13:45:00.000Z",
    "registrationToken": "<temporary-device-poll-token>"
  }
}
```

The QR contains only the short-lived pairing token in the URL fragment. The Roku stores the separate registration token locally; it is not a Delta access or refresh token. Pairing tokens expire after `PAIRING_TOKEN_TTL_SECONDS` (default 900 seconds), are one-use, hashed in the database, rate limited, and invalidated on replacement/expiry.

If the MAC already has a live activation, the unauthenticated registration response is deliberately generic (`status: "session_required"`, `pairing: null`) and does not reveal activation/list details. The Roku uses its existing device session and `/status` for its state.

For the existing partner activation route, send the partner code plus provider credentials:

`POST /api/v1/client/activate/partner`

```json
{
  "code": "AB1234",
  "username": "provider-user",
  "password": "provider-password",
  "mac": "AA:BB:CC:DD:EE:FF",
  "installationId": "roku-AABBCCDDEEFF"
}
```

The legacy individual license activation remains `POST /api/v1/client/activate/license` with `code`, `mac`, and optional `installationId`. After that activation, configure a standalone playlist with the existing short-lived device access token:

`POST /api/v1/client/configure/playlist`

```json
{
  "name": "Minha lista",
  "url": "https://provider.example/list.m3u?user=...&password=..."
}
```

Successful activation keeps the existing token response and adds `configurationStatus`:

```json
{
  "activationId": "activation-uuid",
  "kind": "partner",
  "status": "active",
  "configurationStatus": "configured_partner",
  "expiresAt": "2027-10-17T00:00:00.000Z",
  "reused": false,
  "tokens": {
    "accessToken": "<short-lived-device-access-token>",
    "refreshToken": "<rotating-device-refresh-token>",
    "expiresIn": 600
  }
}
```

Response (`200`):

```json
{
  "activationId": "activation-uuid",
  "mode": "playlist",
  "listName": "Minha lista",
  "configurationStatus": "configured_playlist"
}
```

The configured device can use the existing authenticated `GET /api/v1/client/resources` and `GET /api/v1/client/catalog` contract. Personal playlist entries use `/api/v1/play/me/...` and short-lived play tokens; playback is proxied through the gateway so provider usernames/passwords embedded in media URLs do not appear in catalog or redirect responses.

## 2. Administrator setup

These routes are under `/api/v1/admin/devices`, require an authenticated admin token and the existing `devices:read` or `devices:write` permission:

* `GET /registrations?q=<MAC-or-installationId>` finds registered and activated devices.
* `GET /registrations/:deviceId` returns state and the associated list name/mode, but no URL or credentials.
* `POST /registrations/:deviceId/configuration` previews cancellation or confirms the configuration. Send `confirm:false` to cancel (audited); `confirm:true` applies the change (audited with administrator ID and timestamp).

Standalone list request:

```json
{
  "mode": "playlist",
  "confirm": true,
  "licenseCode": "LIC-...",
  "name": "Minha lista",
  "url": "https://provider.example/list.m3u"
}
```

Partner request:

```json
{
  "mode": "partner",
  "confirm": true,
  "code": "AB1234",
  "username": "provider-user",
  "password": "provider-password"
}
```

The partner code is checked against an active code and its partner; the username/password are probed against that partner's provider and encrypted. Switching between partner and standalone modes rechecks entitlement and device limits, replaces the prior association, and writes an audit event. Users without `devices:write` receive `403 FORBIDDEN`.

## 3. QR and web pairing

The Roku registers as above and shows the returned `pairing.url` as a QR code. Scanning opens `GET /pair`, a minimal web form with:

* partner code + provider IPTV username/password; or
* Delta license code + list name + full playlist URL.

The page submits `POST /api/v1/client/pairing/configure`. The partner request uses the same `mode`, `code`, `username`, and `password` fields as the administrator request, plus `token`. The standalone request is:

```json
{
  "mode": "playlist",
  "token": "<temporary-pair-token>",
  "licenseCode": "LIC-...",
  "name": "Minha lista",
  "url": "https://provider.example/list.m3u"
}
```

Success reports the configured state but does not return a device session to the browser:

```json
{
  "deviceId": "device-uuid",
  "status": "configured_playlist",
  "configured": true,
  "activationId": "activation-uuid",
  "mode": "playlist",
  "listName": "Minha lista",
  "allowed": true,
  "code": "OK",
  "message": "Acesso autorizado.",
  "expiresAt": "2027-10-17T00:00:00.000Z"
}
```

The Roku polls with its separate registration token:

`POST /api/v1/client/register/status`

```json
{
  "mac": "AA:BB:CC:DD:EE:FF",
  "installationId": "roku-AABBCCDDEEFF",
  "registrationToken": "<temporary-device-poll-token>"
}
```

When setup is complete, the response includes the configured state and the normal short-lived device access/refresh tokens once:

```json
{
  "status": "configured_playlist",
  "configured": true,
  "activationId": "activation-uuid",
  "configurationStatus": "configured_playlist",
  "tokens": {
    "accessToken": "<short-lived-device-access-token>",
    "refreshToken": "<rotating-device-refresh-token>",
    "expiresIn": 600
  }
}
```

The Roku can then continue with `/status`, `/resources`, `/catalog`, `/play-token`, and `/session/refresh` as before. Pairing page responses disable caching and referrers; the token is carried in a URL fragment so it is not sent in the initial HTTP request or server access log.

## State values

Registration and poll responses use `status`:

* `awaiting_configuration`
* `configured_partner`
* `configured_playlist`
* `expired`
* `disabled`
* `deactivated`

The authenticated client `/status` response also includes `configurationStatus` and `listName` without returning a playlist URL.

## URL and error policy

Standalone URLs must be absolute HTTP(S) URLs. The backend blocks non-public IPv4/IPv6 destinations and internal hostnames at validation and connection time, checks every redirect, applies a timeout, accepts only playlist-compatible content types, and caps playlist reads at 64 MiB. URLs are encrypted and omitted from audit data and API responses.

For an activation `400`, the existing middleware runs the Zod schema before calling the activation service. The partner route requires `code`, `username`, `password`, and `mac` (with optional `installationId`); the license route requires `code` and `mac`. Schema errors now identify the first invalid field in `message` and list all paths in `details`. A service-level malformed MAC is `INVALID_MAC`; invalid partner credentials return `401 INVALID_CODE_OR_CREDENTIALS`, and an unreachable provider returns `502 PROVIDER_UNREACHABLE`. The legacy app source and a captured failing request are not present in this backend repository, so an exact historical payload-to-field mismatch cannot be asserted from this codebase alone.

Example validation error:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "String must contain at least 1 character(s)",
  "details": [{ "path": "password", "message": "String must contain at least 1 character(s)" }],
  "requestId": "request-uuid"
}
```
