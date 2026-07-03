# Kerby

**Find available street parking in Melbourne CBD, live.**

Kerby pulls real-time occupancy data from City of Melbourne's in-ground
parking sensors and shows you which on-street bays are free, right now,
near where you're driving to.

## What it does

- **Live availability map** — 3,000+ CBD parking bays with sensor-backed
  occupancy status. Green pin = free, red = taken, grey = no sensor / stale
  reading.
- **Filter to available-only** — hide everything except fresh, unoccupied
  bays.
- **Lock a bay** — reserve a spot in the app for 15 minutes while you drive
  to it. Other Kerby users see it as taken. (Doesn't stop a random car
  taking the physical spot — but if that happens, Kerby pings you and
  offers the next-best nearby bay.)
- **Off-street lots too** — 2,600+ commercial and private off-street car
  parks from CoM open data.
- **Save your parked spot** — "I parked here" pins your GPS. Later, "Walk
  back to car" gives you a compass and distance.
- **Saved destinations** — mark places like Work or Home so you can search
  parking near them with one tap.

## What it isn't

- Not a parking reservation service. Locks are inside Kerby only, not with
  the City of Melbourne.
- Not a substitute for reading the sign. Time restrictions, permit zones,
  clearways still apply. Sensor data doesn't cover restriction rules.

## Data

Kerby uses [City of Melbourne Open Data](https://data.melbourne.vic.gov.au)
(CC-BY 4.0) — specifically the on-street parking bays, in-ground sensor
readings, and off-street car park datasets. Data is refreshed roughly every
minute; some sensors are decommissioned and mark bays as "stale" in the
app.

## Get it

_Coming to TestFlight and Play Store — email
[kerby@nnavnita.com](mailto:kerby@nnavnita.com) to join the beta._

## Source

[github.com/nnavnita/kerby](https://github.com/nnavnita/kerby) —
Rust backend (Axum + Postgres/PostGIS + Redis), React Native mobile
(Expo SDK 54).

## Legal

- [Terms of Service](https://kerby-api.fly.dev/legal/terms)
- [Privacy Policy](https://kerby-api.fly.dev/legal/privacy)
