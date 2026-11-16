# White-label scoping

Owner intent (2026-11-13): sell Tambo under partners' brands. Partner types
named: **phone manufacturers (OEMs)**, **insurers and telcos**, **enterprises
and NGOs** (the Device-Owner edition), and **buy-now-pay-later phone sellers
and suppliers**. This page is the scoping record: what varies per partner,
the decisions the owner must take, and what the backend builds for all of them
(B3 to B5 in [program-2026-11.md](program-2026-11.md)).

## What varies per partner, and where it lives

| Varies | Lives in | Notes |
|---|---|---|
| Display name, logo, colour roles, support links | `Partner.brand`, served by `GET /client/config` | Runtime theming: one binary, many brands. Build flavours only for the launcher icon, app name and `applicationId` where a store listing needs them. |
| Terms and privacy documents | `Partner.brand.legal` overriding the legal API versions | Each partner's lawyer signs their own. |
| Feature set | `Partner.features` + the feature flags in client config | A partner may hide buddies or plans, never evidence upload. |
| Plan grants | `User.plan` with `planSource: partner`, `Partner.defaultPlan` | A partner-paid plan is not overwritten by Play Billing. |
| Alert recipients beyond the owner | `Partner.alertRecipients` + B5 webhooks | An insurer's claims desk, a BNPL lender's ops. |
| Who the device belongs to before sign-in | B4 device-first enrolment | OEM and BNPL fleets. |
| Reporting | B5 webhooks first; a partner portal later, mirroring `veriplus-manufacturer-portal` | API-only until a partner asks for a screen. |
| Data residency | Hosting region decision | One region for all partners in v1. |

## Partner types, side by side

| | OEM | Insurer / telco | Enterprise / NGO | BNPL seller |
|---|---|---|---|---|
| Install | Preinstall, system tier | Play / App Store, branded | Device-Owner provisioning | Preinstall or Play at point of sale |
| Who enrols the device | Factory (provisioning tokens) | The customer | The fleet admin | The seller at handover |
| Who is alerted | Owner; OEM via webhook if agreed | Owner + claims desk | Owner + fleet admin | Owner + lender ops |
| Pays | OEM bundle | Partner per seat | Partner per seat | Partner per device |
| Reads evidence | Owner; pack to partner on claim | Owner; pack to claims desk with consent | Admin by role | Owner; lender gets episode events, not photos |
| Out of scope | | | | **Lock-on-default.** Remote device locking for missed payments is a device-control feature, DO or OEM tier only, with its own legal footing. Not anti-theft, not this program. |

## Decisions for the owner (defaults in bold)

| # | Question | Options |
|---|---|---|
| W1 | Theming | **Runtime from client config** vs build flavours per partner |
| W2 | Store listings | **Tambo lists one app per store; partners' brands live inside it** vs partner-owned listings (one upload key per partner, M4 repeated) |
| W3 | Partner visibility into evidence | **Episode events and the PDF pack on the owner's consent; never raw photo URLs** vs full read |
| W4 | Billing model | Per seat / per device / bundle, per partner type; invoiced outside the app in v1 |
| W5 | Portal | **API + webhooks only in v1**; a portal when a second partner asks |
| W6 | First design partner | Name one so B3 to B5 are built against a real integration |
| W7 | Data processing agreement template | Owner's advocate; before the first partner key is issued |

## What B3 builds regardless of the answers

`Partner`, `PartnerApiKey`, `User.partner`, `Device.partner`, `partnerCode` at
register and enrol, `planSource`, and `GET /client/config` with the brand
theme and flags. Everything above plugs into those.
