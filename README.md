# Jal-Mitra

Last-Mile Water Quota & Distribution Protocol — Track 02: Heat, Water & Community Resilience.

**Nobody currently measures litres per household.** Every existing system tracks trucks, trips and
locations — GPS on the tanker, payment tied to the tracker record, a paper book at the stop.
Jal-Mitra is the first ledger of who actually got how much water.

## How tanker delivery works today, and where it breaks

| Today | What goes wrong |
| --- | --- |
| A coordinator sanctions a tanker and a number of trips | Nothing records what happens after the truck arrives |
| Contractors are paid **per trip or per day**, not per litre delivered | No incentive to distribute fairly at the tap |
| Tanker parks at a fixed point, residents queue with pots | Favouritism — tankers parked near particular houses |
| Accountability is a paper record book, at best | Trips not maintained, no analytics, water diverted |

Jal-Mitra inserts a quota layer between the sanctioned trip and the bucket, and leaves an audit
trail that a paper book cannot.

## The five-step flow

The coordinator schedules first. **Nothing can be claimed until a delivery exists** — that is the
step that matches how water actually gets sanctioned.

1. **Coordinator schedules a delivery** (`/dispatch`) — ward, tanker load, arrival window, claim deadline.
2. **The system broadcasts to every registered household in that ward**: *"Tanker arriving in Ward 7 between 8:34 and 9:34 PM. Reply WATER &lt;family size&gt; by 8:19 PM to reserve your quota."*
3. **Residents claim** (`/phone`) by SMS or WhatsApp and get a PIN, plus a QR on smartphones. Claims are checked against the tanker's actual load.
4. **Driver dispenses** (`/driver`) — scan the QR or type the PIN, dispense exactly the approved litres, token locks.
5. **Judges watch the ledger** (`/dashboard`) — litres per household, live tanker fill, blocked claims in red.

Broadcast-then-claim beats auto-issuing a token to everyone: households that are away don't lock up
quota, and unclaimed litres go back to people who want them.

## Who the coordinator is

The same screen, different operator depending on context. Set `COORDINATOR_LABEL` in `.env`.

| Setting | Operator |
| --- | --- |
| Rural | Gram Panchayat / BDO office |
| City | Zonal control room or emergency centre |
| Informal colonies | RWA committee or private tanker association |

This is the adoption story: RWAs, NGOs and tanker associations run delivery today, so no municipal
tender is needed to start.

## Built on AWS

Five services, each one doing a job the product actually needs. **Every one is
optional and self-enables from `.env`** — with all of them blank the app runs
entirely on localhost, which is the stage fallback when venue wifi dies. The
dashboard shows a live strip of which services are on.

| Service | What it does here | Why it belongs |
| --- | --- | --- |
| **Amazon SNS** | Ward broadcast and quota-reply SMS | The broadcast *is* the product's entry point. Without it there is no "tanker is coming" message. |
| **Amazon DynamoDB** | Ward registers + append-only audit ledger | An audit trail that dies on restart isn't an audit trail. Registers load from here at boot. |
| **Amazon S3** | QR images and ledger CSV export | A QR needs a real URL to attach to an SMS/WhatsApp media message. Exports archive the record book. |
| **Amazon CloudWatch** | Litres delivered, claims blocked, unclaimed litres, per ward | The metrics a water utility would actually page on. |
| **AWS IoT Core** | Flow-meter readings from the tanker's ESP32 | Turns "we say 160 L" into "the meter says 160 L". |

Writes to DynamoDB, CloudWatch and SNS are fire-and-forget: a throttle or a
dropped connection can never stall a resident's claim or a tanker mid-dispense.
In-memory stays the hot path; AWS is the durable and outbound layer.

### Setup

Fill the AWS block in `.env`, then provision DynamoDB:

```bash
npm run aws:setup     # creates the tables (PAY_PER_REQUEST) and seeds the registers
```

Flip each service on individually: `SNS_ENABLED`, `DDB_ENABLED`, `S3_ENABLED`,
`CLOUDWATCH_ENABLED`, `IOT_ENABLED`.

**SNS note:** a new account is in the SMS sandbox, so you can only send to
verified numbers. Verify your demo phones in the SNS console, or request
production access. Hindi messages are Unicode, so a segment is 70 characters
rather than 160 — set `SMS_LANGUAGE=en` if cost matters more than reach.

### IAM policy

Minimum for the app's own role (an EC2 instance role is cleaner than keys):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["sns:Publish"], "Resource": "*" },
    { "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:Scan", "dynamodb:DescribeTable"],
      "Resource": "arn:aws:dynamodb:*:*:table/jalmitra-*" },
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/*" },
    { "Effect": "Allow", "Action": ["cloudwatch:PutMetricData"], "Resource": "*" }
  ]
}
```

### Flow meter over IoT Core

The ESP32 publishes cumulative litres to `jalmitra/tanker/+/flow`:

```json
{ "sessionId": "DS-0005", "litres": 95.4 }
```

An IoT Rule (`SELECT * FROM 'jalmitra/tanker/+/flow'`) forwards it to
`POST /api/meter/reading` with the `x-meter-key` header set to `METER_INGEST_KEY`.
The first real reading flips that dispense from simulated to **measured**, and
the audit log records which it was. The meter is authoritative but still bounded
by the approved quota and by what is physically in the tanker.

You can prove the path without hardware:

```bash
curl -X POST http://localhost:3000/api/meter/reading \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"DS-0005","litres":95}'
```

### Deploying

EC2 free tier (t3.micro, Amazon Linux 2023) is the shortest path:

```bash
sudo dnf install -y nodejs git
git clone <your repo> && cd jal-mitra
npm ci --omit=dev
cp .env.example .env && vi .env     # leave the key/secret blank, attach an instance role
sudo npm i -g pm2 && pm2 start server/index.js --name jal-mitra && pm2 save
```

Open port 3000 in the security group. **Camera QR scanning needs HTTPS** — put
CloudFront in front of the instance (it supplies a `*.cloudfront.net` cert and
supports WebSockets) or demo the camera on localhost and use the PIN pad on the
deployed URL.

## Run it locally

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
npm start
```

With an empty AWS block this runs fully offline — no account needed.

| Screen | URL | Who it's for |
| --- | --- | --- |
| Dispatch | http://localhost:3000/dispatch | Coordinator |
| Resident phone simulator | http://localhost:3000/phone | Presenter / projector |
| Driver | http://localhost:3000/driver | Tanker driver tablet |
| Audit dashboard | http://localhost:3000/dashboard | Judges' screen |

## The 3-minute stage flow

1. **Dispatch** — schedule Ward 7, tanker load **900 L**, claims close in 45 min. The preview warns that the ward needs 1,080 L: deliberately short, because scarcity is the point.
2. **Phone** — the broadcast is already sitting in the resident's inbox. Send `WATER 4` as Sunita Devi → 160 L reserved, PIN + QR.
3. **Driver** — scan the QR or type the PIN. Confirm shows household, ward and approved litres.
4. **Start Dispense** — litres count up, the Ward 7 tanker drains live on the dashboard.
5. **Phone** — same household claims again → rejected, dashboard flashes **DUPLICATE BLOCKED**.
6. **Scarcity** — keep claiming down the Ward 7 register. After five households book 800 L, Imran Qureshi (7 members, 280 L) is refused: only 100 L left. The tanker *stays open* so a smaller household could still use those litres.
7. **Dashboard** — pick Ward 7 in the register and show entitled vs. served, household by household. That column is the thing no existing system has.

## Ward registers

Three wards, 17 households, 76 people. Each household is a row in its ward's register: house
number, family head, members on record, entitlement, litres actually served, token status.

| Ward | Households | People | Entitled at 40 L/person |
| --- | --- | --- | --- |
| Ward 7 | 6 | 27 | 1,080 L |
| Ward 12 | 6 | 27 | 1,080 L |
| Ward 19 | 5 | 22 | 880 L |

The dashboard has a **ward selector** (or click a ward card) that scopes the register, the
delivery panel and the audit log to one ward. Water on the road and the central totals stay
all-wards, since one tanker serves one ward but the fleet is shared. Edit `server/seed.js` to
change the registers.

## Why 40 litres per person

Tanker delivery in practice works out to roughly **40–50 litres per head per day**, so 40 is the
default — defensible if a judge challenges it. 20 L covers drinking and cooking only; that is a
survival floor, not a household's needs. It is `LITRES_PER_PERSON` in `.env` and is meant to be
tuned per ward and per season.

## What makes it trustworthy

1. **Nothing can be claimed without a scheduled delivery.** No phantom reservations.
2. One active token per household **per delivery**.
3. Reservations can never exceed the tanker's actual load. A claim too big for the remaining litres is refused, but the tanker stays open so a smaller household can still use them — closing early would strand water on the truck.
4. PINs are 4 digits, unique among active tokens, single-use, and valid until the tanker leaves plus a grace period.
5. QR payloads are HMAC-SHA256 signed — a forged or edited QR is rejected.
6. Quota comes from the family size **on record**, not the number typed in the message. A claim well above the record is flagged in the audit log.
7. Dispensing never exceeds the approved litres and stops if the tanker runs dry.
8. Claims close automatically at the deadline, and unclaimed litres are logged as released.
9. Every action is written to the audit log — the digital version of the record book that WHO tankering guidance asks for (quantity delivered, and who received it).

## Going live with WhatsApp (optional)

The simulator posts to `POST /api/sms/incoming` — the exact endpoint Twilio calls, so no code changes.

1. `ngrok http 3000` (start it early; the URL changes on restart).
2. Twilio WhatsApp Sandbox → "When a message comes in" → `https://<tunnel>/api/sms/incoming`.
3. Set `PUBLIC_BASE_URL=https://<tunnel>` in `.env` so the QR is attached as a media message.

Replies are TwiML, so the `twilio` SDK is not a dependency.

**Pitch rule:** try the live phone first. If it lags more than ~5 seconds, switch to the simulator
without comment — "same backend, simulated network."

## API

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/delivery/schedule` | Schedule a tanker and broadcast to the ward |
| POST | `/api/delivery/close` | Close claims early |
| POST | `/api/delivery/complete` | Mark the delivery finished |
| GET | `/api/deliveries` | All deliveries with reserved/delivered/unclaimed litres |
| POST | `/api/sms/incoming` | Twilio webhook and simulator entry |
| GET | `/api/resident/inbox?phone=` | What a resident's phone should show |
| POST | `/api/token/validate` | Takes a PIN or a signed QR token |
| POST | `/api/dispense/start` / `stop` | Run a dispense session |
| GET | `/api/dashboard/state` | Full dashboard state |
| POST | `/api/meter/reading` | Flow-meter litres, forwarded by an AWS IoT Rule |
| GET | `/api/aws/status` | Which AWS services are live |
| POST | `/api/ledger/export` | Write the audit log to S3 as CSV |
| POST | `/api/demo/reset` | Clear everything |
| WS | `/ws` | `delivery_scheduled`, `token_created`, `dispense_progress`, `duplicate_attempt`, `capacity_full`, `claims_closed` |

## Answers to likely objections

**"How do you get municipal approval?"** You don't need it to start. RWAs, NGOs and private tanker
associations run delivery today and can adopt this directly.

**"Isn't this GPS tanker tracking?"** GPS tracks the truck to the neighbourhood and ties the
contractor's payment to the tracker. It says nothing about who filled a bucket. This is the only
layer that records litres per household.

**"What if someone has no phone?"** Ward volunteers generate tokens through an agent portal
(not built — stretch goal). Verify local phone-ownership figures before quoting a number.

**"Is 40 L enough?"** See above — it matches observed tanker delivery and is configurable.

## If something breaks on stage

| Problem | Fallback |
| --- | --- |
| Camera won't open | Needs HTTPS or localhost. Type the PIN — the pad is always there. |
| QR won't scan | Max brightness, hold closer, or type the PIN. |
| No internet | Everything runs on localhost. Only the Twilio layer needs the tunnel. |
| State got messy | **Reset demo** on the dashboard or the phone page. |
| Residents can't claim | Check a delivery is scheduled for their ward and claims are still open. |

## Known gaps, stated plainly

- **The flow meter is wired but the hardware isn't built.** `POST /api/meter/reading` works and the ledger marks every dispense as measured or simulated, so the honest demo answer is "the path is real, the sensor is next" rather than pretending the litres are metered.
- **Registration is assumed.** Getting households onto a ward register with truthful family sizes is the hardest field problem and this doesn't solve it.
- **No auth on the dispatch and driver screens.** Amazon Cognito is the obvious fix; it was cut for time.
- Not built: tests, agent portal for volunteers, route optimisation, priority tokens for elderly and medical cases, proportional scale-down when a ward is oversubscribed.
