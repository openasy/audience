# audience

[![CI](https://github.com/openasy/audience/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/audience/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Audience product: one profile per person, fed by the events of Analytics,
Forms, CRM, Messages, CSV imports and your own applications, and segments defined by rules that stay up to date as
people act. Messages and Campaigns read a segment's members; CRM sees what a lead did; each profile shows what the
person agreed to in Consent. A person deleted on request is deleted in every linked product too, and the request is
logged.

```
audience.yaml ──▶ audience ◀── POST /api/v1/events ◀── Forms, CRM, Messages, your apps
                   │  ▲  ▲
                   │  │  └── visits of identified visitors ◀── Analytics (read every few minutes)
                   │  └───── what the person agreed to ◀────── Consent
                   └──────── /api/v1/segments/{id}/members ──▶ Messages, Campaigns
```

## Who is who

Two records are one person when they share an **email**, a **phone number** or **your user id**, and only then.
Nothing else is compared: no device fingerprints, no IP addresses, no names. Emails are lowercased; phone numbers are
written in E.164 (`0555 111 22 33` is `+905551112233` with `phone_country: TR`), as Consent and İYS write them.

- A record that matches one profile adds to it: new identifiers, traits, events.
- A record that matches several profiles joins them into one: identifiers, events and visitors move, and for a trait
  both have, the newer value wins. The old profile id still finds the person (`GET /api/v1/people/{old id}`).
- **A profile has at most one user id.** Two profiles with different user ids are never joined, whatever else they
  share; a shared email stays with the profile that had it, and the record counts a `conflict`. Without a user id on
  the record, the profile with the email decides, then the one with the phone.
- `match_by` in the file can leave out a kind: `match_by: [user_id]` keeps emails on profiles but never matches by them.
  A change to it applies to records from then on.

## Traits, events and segments

**Traits** are what the file declares, in its types (`string`, `number`, `boolean`, `date`), from the sources it allows
(`from`). Anything else is left out and named in the answer's `ignoredTraits`. A value older than the one kept does
not replace it; `null` removes a trait.

**Events** have a source (`analytics`, `forms`, `crm`, `messages`, `import`, `api`), a type such as `page_viewed`,
`form_submitted` or `deal_opened`, a time, optional properties and the text the timeline shows. An event with an `id`
is kept once per source, however often it is sent. Events older than `events.keep` are deleted; the profile stays.

**Segments** are rules, made in the UI or the API:

```json
{
  "all": [
    { "trait": "plan", "op": "is", "value": "Free" },
    { "event": "page_viewed", "op": "at_least", "count": 1, "days": 30, "where": { "path": "/pricing" } },
    { "event": "deal_opened", "op": "none", "source": "crm" }
  ]
}
```

| Condition | | |
| --- | --- | --- |
| `{ all: [...] }`, `{ any: [...] }` | | Every condition holds, or at least one; groups nest up to 4 deep, 50 conditions in all |
| `trait`, `op`, `value` | string | `is`, `is_not`, `in`, `not_in`, `contains`, `exists`, `missing`; case is ignored, with I, İ, ı and i the same letter |
| | number | `is`, `is_not`, `gt`, `gte`, `lt`, `lte`, `exists`, `missing` |
| | boolean | `is`, `is_not`, `exists`, `missing` |
| | date | `is`, `before`, `after`, `within_last` and `within_next` with `days`, `exists`, `missing` |
| `event`, `op` | | `at_least`, `at_most`, `exactly` with `count` (1 by default), or `none`; in the last `days` days, or ever without it; only from `source`; only with the properties in `where` equal |
| `identifier`, `op` | | `email`, `phone` or `user_id`: `exists` or `missing` |

`is_not` and `not_in` hold for people without the trait; `none` holds for people who never had the event, or not in
the period. A period runs from `days` days before now until now.

A person is in a segment while its rules hold, and leaves it as soon as they do not. Each segment is one SQL
condition over the profiles, their traits (by profile and key) and their events (by profile, type and time), so tens
of thousands of profiles are counted in one query: the tests count 40,000 profiles with 400,000 events in well under a
second. The members a product reads, the CSV export and the segments on a profile are evaluated when they are asked
for. The stored membership, which gives the size over time and who joined and left, follows events as they come in
(only the people they are about are evaluated again) and is counted again in full every `segments.recount`, for rules
with a period, which change as days pass.

## The file

Everything that decides matching and linking is set in `/config/audience.yaml` (`AUDIENCE_CONFIG`):

```yaml
match_by: [email, phone, user_id] # never device fingerprints
phone_country: TR
traits:
  plan: { values: [Free, Pro, Business], from: [api, crm, import] }
  city: { from: [forms, import, api] }
  renewal_date: { type: date, from: crm }
sources:
  analytics: { token: AUDIENCE_ANALYTICS_TOKEN, sites: [shop] }
  consent: { token: AUDIENCE_CONSENT_TOKEN }
  forms: true # its events come in; nothing is deleted there
  crm: { url: http://crm:8080, token: AUDIENCE_CRM_TOKEN }
events: { keep: 25mo }
segments: { recount: 15m }
```

It is read at start and again within a minute of a change, and applied whole or not at all; a file with a mistake
leaves the last good version in place, and the log, the overview and Settings say what to fix. Mount the folder
rather than the file, so a save that replaces the file still reaches the container.

| Field | Default | |
| --- | --- | --- |
| `match_by` | all three | One or more of `email`, `phone`, `user_id` |
| `phone_country` | `TR` | For numbers without a country code: `TR`, `DE`, `AT`, `CH`, `NL`, `BE`, `FR`, `GB`, `IE`, `AZ`, `US` |
| `traits.<name>` | | `type` (`string`), `values` (for strings: the only values), `from` (sources that may set it) |
| `sources.<product>` | | `analytics`, `consent`, `forms`, `crm`, `messages`. `token` names the environment variable with that product's API token, never the token; `url` is where Audience calls it, else its address in `OPENASY_PRODUCTS`; `delete` (`true` with a token) passes deletions on |
| `sources.analytics.sites` | required | Analytics' sites whose identified visitors become profiles; `pull` (`5m`) how often they are read |
| `events.keep` | `25mo` | 30 days to 10 years, such as `400d`, `2y` |
| `segments.recount` | `15m` | `1m` to `24h`, or `nightly` |

## The linked products

**Analytics.** Audience reads `GET /api/v1/visits` of each site, newest first, until the last visit it read. A visit
with a user id (the site's `openasy.identify()`) belongs to the profile with that user id, made if new; the visitor's
earlier visits on the site, before they signed in, and their later ones come with it. Each visit becomes
`visit_started`, `page_viewed`, the site's own events (by their name) and `form_submitted` for forms sent, read from
`GET /api/v1/visits/{id}`. Visits of visitors never identified stay in Analytics. The token needs the viewer role in
Analytics to read and the admin role to delete visitors.

**Consent.** A profile shows the person's latest answers in Consent, found with `GET /api/v1/people?q=` by each of
their emails, phone numbers and user id, checked exactly. Deletions reach Consent with
`DELETE /api/v1/people/{id}?reason=<reference>`, which needs the admin role there. Audience never records consent;
imported people are not assumed to have agreed to anything.

**Forms, CRM and Messages** post their events to Audience (below) with an Audience token of the editor role, once
linked in the file; until then, an event with their source is refused.

## The event API

```bash
curl -s -X POST https://audience.example.com/api/v1/events -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{ "events": [{
    "source": "crm", "type": "deal_opened", "id": "deal-7:opened", "at": "2026-11-08T09:30:00Z",
    "person": { "email": "gizem@example.com", "phone": "0532 000 00 12", "userId": "u-0877", "name": "Gizem Avcı" },
    "traits": { "plan": "Business" },
    "properties": { "deal": "Avcı Lojistik renewal", "stage": "Proposal", "status": "open" },
    "text": "Deal Avcı Lojistik renewal moved to Proposal"
  }] }'
```

Up to 1000 events at once, checked whole: one event that cannot be read refuses the batch with a 422 that names it.
`source` is `api` (the default), `forms`, `crm` or `messages`; `person` needs one of the identifiers the file matches
by; `at` may be in the past and at most a day ahead; `properties` take up to 4 KiB of JSON, and segments compare their
top-level values. The answer gives each event's profile, whether it was made or joined (`created`, `merged`), whether
it was a duplicate, and the traits left out. `POST /api/v1/profiles` takes a person and traits without an event.

Suggested types, so segments can be shared: Forms `form_submitted` (`form`); CRM `contact_created`, `deal_opened`,
`deal_stage_changed`, `deal_won`, `deal_lost` (`deal`, `stage`, `status`); Messages `message_sent`, `message_opened`,
`message_clicked`, `message_bounced`, `unsubscribed` (`campaign`, `channel`).

## The segment API

```bash
curl -s https://audience.example.com/api/v1/segments -H "authorization: Bearer $TOKEN"
curl -s "https://audience.example.com/api/v1/segments/$ID/members?limit=1000" -H "authorization: Bearer $TOKEN"
curl -s "https://audience.example.com/api/v1/segments/$ID/changes?cursor=$CURSOR" -H "authorization: Bearer $TOKEN"
```

`members` gives id, name, emails, phone numbers, user id and traits, in profile id order with `nextCursor`, evaluated
when it is asked. Each reader is noted, by its token's name, and shown as "used by". Audience does not check consent;
the product that sends checks each person with Consent. `changes` lists who joined and left after the cursor, kept 90
days, for journeys that start when someone enters. `GET /api/v1/segments/{id}/export` is the CSV: id, name, email,
phone, user id and every trait; a value a spreadsheet would run as a formula starts with an apostrophe. A viewer
token reads all of these.

## Deletion on request

An admin deletes a person from their profile (`DELETE /api/v1/people/{id}?reference=KVKK-2026-031`), or by email,
phone or user id with `POST /api/v1/deletions`, also for someone who has no profile here. For a request under KVKK
Art. 7 and 11 or GDPR Art. 17:

1. Here, at once: every profile with any of the identifiers, with its traits, events, memberships and Analytics
   visitors.
2. Each product under `sources` with `delete: true` gets a task: Analytics deletes every visitor of the person
   (`DELETE /api/v1/visitors/{id}?site=`), Consent erases the person with the reference as the reason, and Forms, CRM
   and Messages receive `POST /api/v1/erasures`:

   ```json
   { "reference": "KVKK-2026-031", "product": "audience", "people": { "emails": ["…"], "phones": ["…"], "userIds": ["…"] } }
   ```

   They answer 200 `{ "status": "done", "deleted": 1 }`, or 202 `{ "status": "waiting", "detail": "An open deal has an
   invoice not yet paid." }` while they must keep the person; Audience asks again every hour with the same reference.
   A product that cannot be reached, or answers 5xx, is tried again after 1, 2, 4 minutes and so on, up to 6 hours. A
   refused token, a 404 or another 4xx marks the task failed with the product's message, shown on Deletion requests,
   until someone fixes it and chooses Try again.
3. The log keeps the reference, the time, who recorded it, how many profiles and events were deleted here and each
   product's state. Nobody can change or delete it. A task holds the identifiers its product needs only until it is
   done, then they are cleared; a waiting or failed task keeps them until then.

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/audience.yaml   # matching, traits and the linked products
docker compose up -d
docker compose logs audience | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and the
API are on http://localhost:8080; the API reference is at `/api/docs/`, and every response is tested against
`openapi.json`. `openasy-kek` encrypts sign-in secrets in the database (ADR 0021): keep it apart from the volume and
with your backups.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `AUDIENCE_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `AUDIENCE_CONFIG` | `/config/audience.yaml` | The file |
| the file's `token` names | | Each linked product's API token, such as `AUDIENCE_ANALYTICS_TOKEN` |
| `OPENASY_PRODUCTS` | | The install's other products, for the product switcher and for sources without a `url` |
| `AUDIENCE_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `AUDIENCE_DB` | `/data/audience.db` | SQLite file (WAL), on the `/data` volume |
| `AUDIENCE_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `AUDIENCE_HEADLESS` | `false` | `true` serves only the API |
| `AUDIENCE_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Request
logs never hold the query string, which may name people.

## Roles

Viewers see people, segments, imports and the deletion log, and read segment members; editors also send events, add
people, make segments and import files; admins also export a person's data, delete on request, read Analytics now,
and manage members and API tokens (ADR 0003). Give each product its own token, so "used by" and the logs say which.

## Limits

- It does not send messages; that is Messages. It does not record consent; that is Consent.
- People are matched only by email, phone or your user id, never by device fingerprints.
- Forms, CRM and Messages are not built yet. The event API they post to and the erasure call they answer are defined
  here and tested against a fake product; the fakes of Analytics and Consent follow their `openapi.json`.
- A person deleted here who comes back, or whom a product that is still waiting sends again, becomes a new profile.

## Develop

```bash
npm install
npm test        # the file, matching, the rules against a plain reading on random people, 40,000 profiles, imports, the linked products against fakes, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
