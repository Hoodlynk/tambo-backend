# F1 Android audit — findings and the exact fix

**Audited:** `tabo-main` (React Native 0.87 bare, package `com.tamboapp`),
snapshot of 2026-09-08.
**Against:** [f1-client-contract.md](f1-client-contract.md) — the wire contract
the device must speak — and [f1-how-it-is-built.md](f1-how-it-is-built.md).
**Audience:** the Android engineer. Every fix below is written to be pasted,
adapted to the repo's style, and reviewed — not treated as gospel.

---

## 1. Verdict in one paragraph

The app detects the **wrong signal**, keeps it in the **wrong place**, and
sends it **nowhere**. It logs *successful* unlocks (`ACTION_USER_PRESENT`)
instead of *failed* ones (`DeviceAdminReceiver.onPasswordFailed`); it parks
events in SharedPreferences/AsyncStorage on the theft device itself, readable
only when the owner's app UI runs — which, after a theft, it never will; and
nothing calls `POST /api/v1/evidence`, so the backend's threshold trigger,
first alert, activity report, and evidence pack all sit idle. Auth is wired
correctly (register/login/refresh against `api.tambo-app.com`, single-flight
token refresh), so the account half exists — the F1 spine does not. The good
news: a correct `device_admin.xml` with `<watch-login/>` already exists, so
the missing detection is genuinely a wiring-plus-one-override job; the upload
pipeline is the real build.

---

## 2. Findings

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | **Blocker** | Failed-unlock detection not implemented. `MyDeviceAdminReceiver.kt` overrides only `onEnabled`/`onDisabled` — no `onPasswordFailed` — and is **not registered in the manifest**, so Android never instantiates it. Nothing ever asks the user to activate device admin either. | `android/.../security/MyDeviceAdminReceiver.kt`, `AndroidManifest.xml` |
| 2 | **Blocker** | Wrong signal captured: `UnlockReceiver` listens for `ACTION_USER_PRESENT`, which fires on **successful** unlock — the owner's own usage, not an attacker's failed attempts. F1's entire premise is the failed attempt. | `android/.../security/UnlockReceiver.kt` |
| 3 | **Blocker** | No backend upload of evidence. Events go native SharedPreferences → JS `AsyncStorage` (`unlock_events`) and stop there. No device enrolment (`POST /api/v1/devices`), no ingest-token storage, no `POST /api/v1/evidence`. The owner's activity screen and the threshold/first-alert pipeline receive nothing. | `src/utils/UnlockLogger.ts`, `src/redux/services/*` |
| 4 | **Blocker (architecture)** | The capture path depends on the **JS runtime**: the native module only persists and then emits to React; syncing and any future upload live in JS hooks (`useUnlockListener`). After a theft the owner's app UI never runs on that phone again — the theft path must live **entirely in native code** (receiver → queue → WorkManager upload), with JS only reading state for the owner's screens. | `security/UnlockAttemptModule.kt`, `src/hooks/useUnlockListener.ts` |
| 5 | High | `ACCESS_BACKGROUND_LOCATION` is declared in the manifest but never requested at runtime (`UnlockLogger.requestLocationPermission` asks only for `ACCESS_FINE_LOCATION`). Background fixes will be permission-denied — this is the F3 bug. It is also a Play-review liability: a declared background-location permission demands an in-app disclosure + video at review time. | `AndroidManifest.xml`, `src/utils/UnlockLogger.ts` |
| 6 | Medium | Location uses `LocationManager.getLastKnownLocation` (stale, often null) in the receiver rather than the Fused Location Provider with a fresh `getCurrentLocation`. | `security/UnlockReceiver.kt` |
| 7 | Medium | No boot receiver: any queued-but-unsent evidence has no upload trigger after a reboot until the owner opens the app. (WorkManager below fixes this for free — its jobs survive reboot — but only once evidence flows through WorkManager.) | `AndroidManifest.xml` |
| 8 | Low | `UnlockAttemptModule.getPendingEvents` clears the pending list **after** invoking the callback but **before** JS has durably stored the events — a crash in between loses them. Moot once the queue moves native-side, per finding 4. | `security/UnlockAttemptModule.kt` |
| 9 | Info (good) | `res/xml/device_admin.xml` already exists and is correct: `<uses-policies><watch-login/></uses-policies>` is exactly the policy `onPasswordFailed` needs. | `res/xml/device_admin.xml` |
| 10 | Info (good) | Auth plumbing is solid and matches the backend: base `https://api.tambo-app.com/api/`, Bearer access token, single-flight refresh with family-burn awareness, TTL parsing of `expiresIn`. F1 endpoints must be authored as `v1/devices`, `v1/evidence`, … against that base (auth lives at `/api/auth`, evidence at `/api/v1/...` — both resolve). | `src/redux/services/index.ts`, `src/utils/token.ts` |
| 11 | Info | Tokens live in AsyncStorage (plaintext on disk). Acceptable for the owner's session; **not** acceptable for the ingest token, which must outlive UI logins and is stored native-side, Keystore-wrapped (§5). | `src/utils/token.ts` |

Biometric blind spot (contract §2): `onPasswordFailed` fires for PIN /
password / pattern only. Fingerprint/face failures are invisible to device
admin by design — set expectations accordingly; do not chase them.

---

## 3. Fix — detection (findings 1, 2)

### 3.1 Manifest

Register the device-admin receiver (the `BIND_DEVICE_ADMIN` permission means
only the system can invoke it) and drop the misleading `USER_PRESENT`
receiver or keep it strictly for owner-facing UX — it must not feed evidence.

```xml
<!-- inside <application> -->
<receiver
    android:name=".security.MyDeviceAdminReceiver"
    android:permission="android.permission.BIND_DEVICE_ADMIN"
    android:exported="true">
    <meta-data
        android:name="android.app.device_admin"
        android:resource="@xml/device_admin" />
    <intent-filter>
        <action android:name="android.app.action.DEVICE_ADMIN_ENABLED" />
    </intent-filter>
</receiver>
```

`res/xml/device_admin.xml` needs no change — `<watch-login/>` is already the
right (and only) policy. Requesting the minimum policy set matters for Play
review.

### 3.2 The receiver

Both overloads matter: API 26+ delivers the three-arg overload, older devices
the two-arg one (minSdk 24). Capture must be synchronous-ish and cheap — a
`DeviceAdminReceiver` runs on the main thread with a ~10s broadcast budget;
enqueue locally, then hand the network to WorkManager.

```kotlin
package com.tamboapp.security

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.os.UserHandle

class MyDeviceAdminReceiver : DeviceAdminReceiver() {

    override fun onPasswordFailed(context: Context, intent: Intent, user: UserHandle) {
        recordFailure(context)
    }

    @Deprecated("Pre-API-26 path")
    override fun onPasswordFailed(context: Context, intent: Intent) {
        recordFailure(context)
    }

    override fun onPasswordSucceeded(context: Context, intent: Intent, user: UserHandle) {
        // A success resets the local attempt counter used for `attemptNo`
        // in the payload. It does NOT reset anything server-side — the
        // server's 10-minute receipt window is the only counter that matters.
        EvidenceQueue.resetAttemptCounter(context)
    }

    @Deprecated("Pre-API-26 path")
    override fun onPasswordSucceeded(context: Context, intent: Intent) {
        EvidenceQueue.resetAttemptCounter(context)
    }

    private fun recordFailure(context: Context) {
        val attemptNo = EvidenceQueue.nextAttemptNumber(context)
        EvidenceQueue.enqueueUnlockFailed(context, attemptNo)
        EvidenceUploadWorker.enqueue(context)
    }
}
```

Notes:

- **Do not** try to distinguish pin/password/pattern from the intent — the
  broadcast doesn't say. Send `"method": "unknown"` or omit it; the server
  treats the payload as opaque (contract §2).
- **Do not** count toward any threshold on the device (contract §4). The
  local `attemptNo` is narrative color for the pack, nothing more.
- The system starts the app **process** to deliver this broadcast even if the
  app was never opened since boot — that is why detection needs no boot
  receiver and no foreground service.

### 3.3 Asking the user to activate device admin

Device admin is opt-in via a system screen; without it, `onPasswordFailed`
never fires. Add to the native module (surfaced during onboarding, with an
honest explanation — this screen scares users):

```kotlin
@ReactMethod
fun requestDeviceAdmin() {
    val component = ComponentName(reactApplicationContext, MyDeviceAdminReceiver::class.java)
    val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
        putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, component)
        putExtra(
            DevicePolicyManager.EXTRA_ADD_EXPLANATION,
            "Tambo uses this to detect failed unlock attempts if your phone is stolen."
        )
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    reactApplicationContext.startActivity(intent)
}

@ReactMethod
fun isDeviceAdminActive(promise: Promise) {
    val dpm = reactApplicationContext
        .getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    val component = ComponentName(reactApplicationContext, MyDeviceAdminReceiver::class.java)
    promise.resolve(dpm.isAdminActive(component))
}
```

The owner's UI should surface "protection off" whenever `isAdminActive` is
false (the user can revoke it in Settings at any time; `onDisabled` fires —
queue a `STATUS` envelope there so the pack records the gap).

---

## 4. Fix — native evidence queue (findings 3, 4, 8)

The queue is the heart of the contract's capture-cheap/upload-relentlessly
model, and the hashing rule (contract §2, "read this twice") dictates the
design: **the envelope is finalized at capture time** — payload serialized
once, hashed once, stored verbatim — and never re-serialized on the way out.

```kotlin
package com.tamboapp.security

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

object EvidenceQueue {
    private const val PREFS = "tambo_evidence_queue"
    private const val KEY_QUEUE = "envelopes"
    private const val KEY_ATTEMPT = "attempt_counter"
    private const val MAX_QUEUED = 500 // drop-oldest beyond this; UNLOCK_FAILED is tiny

    private val lock = Any()

    fun enqueueUnlockFailed(context: Context, attemptNo: Int) {
        // Serialize ONCE; this exact string is what gets hashed AND sent.
        val payload = JSONObject()
            .put("attemptNo", attemptNo)
            .put("method", "unknown")
            .toString()
        enqueue(context, type = "UNLOCK_FAILED", payload = payload)
    }

    fun enqueue(context: Context, type: String, payload: String) {
        val envelope = JSONObject()
            .put("id", UUID.randomUUID().toString())
            .put("type", type)
            .put("capturedAt", Instant.now().toString())
            .put("payload", payload)
            .put("sha256", sha256Hex(payload))

        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = JSONArray(prefs.getString(KEY_QUEUE, "[]") ?: "[]")
            queue.put(envelope)
            val trimmed = if (queue.length() > MAX_QUEUED) {
                JSONArray().also { out ->
                    for (i in queue.length() - MAX_QUEUED until queue.length()) {
                        out.put(queue.get(i))
                    }
                }
            } else queue
            prefs.edit().putString(KEY_QUEUE, trimmed.toString()).commit() // commit(): survive process death now
        }
    }

    /** Envelopes are removed ONLY here, and only by id, only after the server
     *  answered `acked` or `duplicate` for that id. A crash mid-upload means
     *  a safe resend, never a loss. */
    fun removeByIds(context: Context, ids: Set<String>) {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = JSONArray(prefs.getString(KEY_QUEUE, "[]") ?: "[]")
            val remaining = JSONArray()
            for (i in 0 until queue.length()) {
                val env = queue.getJSONObject(i)
                if (env.getString("id") !in ids) remaining.put(env)
            }
            prefs.edit().putString(KEY_QUEUE, remaining.toString()).commit()
        }
    }

    fun peekBatch(context: Context, max: Int = 100): List<JSONObject> {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = JSONArray(prefs.getString(KEY_QUEUE, "[]") ?: "[]")
            return (0 until minOf(queue.length(), max)).map { queue.getJSONObject(it) }
        }
    }

    fun nextAttemptNumber(context: Context): Int = synchronized(lock) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val next = prefs.getInt(KEY_ATTEMPT, 0) + 1
        prefs.edit().putInt(KEY_ATTEMPT, next).commit()
        next
    }

    fun resetAttemptCounter(context: Context) = synchronized(lock) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putInt(KEY_ATTEMPT, 0).commit()
    }

    private fun sha256Hex(s: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
```

Design points worth defending in review:

- **Id = idempotency key.** The UUID is minted once at capture and travels
  with every retry of that event. Never regenerate on retry (contract §2).
- **Removal is ACK-driven, by id.** This replaces the read-then-clear race in
  the current `getPendingEvents` (finding 8): nothing is deleted until the
  server has confirmed it.
- `commit()` over `apply()` on the enqueue path: the process may be killed
  right after a broadcast; the write must be on disk before the receiver
  returns.
- Retire `UnlockLogger.ts` / `useUnlockListener.ts` as evidence carriers. If
  the owner-facing UI wants a local "recent attempts" list, read it from the
  server (`GET /api/v1/devices/:id/activity`) — one source of truth, and it
  works from the owner's *other* phone, which is the phone that matters.

---

## 5. Fix — ingest token storage + uploader (finding 3)

### 5.1 Gradle

```groovy
// android/app/build.gradle
dependencies {
    implementation "androidx.work:work-runtime-ktx:2.9.1"
    implementation "androidx.security:security-crypto:1.1.0-alpha06"
    // OkHttp already ships transitively with React Native
}
```

### 5.2 Token store (Keystore-wrapped, per contract §1)

The ingest token authenticates the **device**, not the user; it must survive
logout, session revocation, and app-UI death. Keep it out of AsyncStorage.

```kotlin
package com.tamboapp.security

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

object DeviceIdentity {
    private const val PREFS = "tambo_device_identity"

    private fun prefs(context: Context) = EncryptedSharedPreferences.create(
        context, PREFS,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun store(context: Context, deviceId: String, ingestToken: String) {
        prefs(context).edit()
            .putString("deviceId", deviceId)
            .putString("ingestToken", ingestToken)
            .commit()
    }

    fun ingestToken(context: Context): String? = prefs(context).getString("ingestToken", null)
    fun deviceId(context: Context): String? = prefs(context).getString("deviceId", null)
    fun clear(context: Context) { prefs(context).edit().clear().commit() }
}
```

Bridge methods so the RN enrolment flow can hand the token down exactly once:

```kotlin
@ReactMethod
fun storeDeviceIdentity(deviceId: String, ingestToken: String, promise: Promise) {
    DeviceIdentity.store(reactApplicationContext, deviceId, ingestToken)
    promise.resolve(true)
}

@ReactMethod
fun isEnrolled(promise: Promise) {
    promise.resolve(DeviceIdentity.ingestToken(reactApplicationContext) != null)
}
```

### 5.3 The upload worker

WorkManager gives the whole retry story for free: network-constrained,
exponential backoff, survives process death **and reboot** (finding 7).

```kotlin
package com.tamboapp.security

import android.content.Context
import androidx.work.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class EvidenceUploadWorker(context: Context, params: WorkerParameters) :
    Worker(context, params) {

    override fun doWork(): Result {
        val token = DeviceIdentity.ingestToken(applicationContext)
            ?: return Result.success() // not enrolled: nothing to do, don't retry

        val batch = EvidenceQueue.peekBatch(applicationContext, max = 100)
        if (batch.isEmpty()) return Result.success()

        val body = JSONObject()
            .put("envelopes", JSONArray().apply { batch.forEach { put(it) } })
            .toString()

        val request = Request.Builder()
            .url("$BASE_URL/api/v1/evidence")
            .header("X-Device-Token", token)
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        val response = try {
            client.newCall(request).execute()
        } catch (_: java.io.IOException) {
            return Result.retry() // offline / flaky network: WorkManager backs off
        }

        response.use {
            when {
                it.code == 200 -> {
                    val parsed = JSONObject(it.body?.string() ?: return Result.retry())
                    handleResults(parsed)
                    // More left in the queue (batch cap, or new arrivals)? Go again.
                    return if (EvidenceQueue.peekBatch(applicationContext, 1).isEmpty())
                        Result.success() else Result.retry()
                }
                it.code == 401 -> return Result.success()
                // Token revoked/rotated away from us. Retrying is useless; the
                // queue is preserved so evidence uploads resume after re-enrolment.
                it.code == 429 -> return Result.retry() // honors backoff; Retry-After ~ minutes
                else -> return Result.retry()
            }
        }
    }

    private fun handleResults(parsed: JSONObject) {
        val done = mutableSetOf<String>()
        val results = parsed.getJSONArray("results")
        for (i in 0 until results.length()) {
            val r = results.getJSONObject(i)
            when (r.getString("status")) {
                "acked", "duplicate" -> done.add(r.getString("id"))
                "rejected" -> {
                    // hash_mismatch = our serialization bug; id_conflict = id
                    // collision. Neither is retryable as-is (contract §2).
                    // Drop it rather than poison-pill the queue, and log loudly.
                    done.add(r.getString("id"))
                    android.util.Log.e("Tambo", "envelope rejected: ${r.optString("reason")}")
                }
            }
        }
        EvidenceQueue.removeByIds(applicationContext, done)

        if (parsed.optBoolean("episodeOpened", false)) {
            // Threshold just crossed server-side; first alert already sent.
            // Cue for F3: start the location-trail fan-out, expedite uploads.
            EpisodeState.onEpisodeOpened(applicationContext, parsed.optString("episodeId"))
        }
    }

    companion object {
        private const val BASE_URL = "https://api.tambo-app.com"
        private val client = OkHttpClient()

        fun enqueue(context: Context) {
            val work = OneTimeWorkRequestBuilder<EvidenceUploadWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                "tambo-evidence-upload",
                ExistingWorkPolicy.KEEP, // one uploader; queue drains everything anyway
                work,
            )
        }
    }
}
```

(`EpisodeState` is a small stub until F3: persist the episode id, no-op
otherwise.)

Why these choices:

- **`ExistingWorkPolicy.KEEP`** — the worker drains the whole queue, so a
  second enqueue while one runs adds nothing; KEEP avoids cancel-thrash.
- **Resend-the-batch retry** is exactly what the contract blesses: landed
  envelopes come back `duplicate`, missing ones `acked` (§2, idempotency).
- **`rejected` is removed, not retried.** `hash_mismatch` and `id_conflict`
  are both deterministic — retrying loops forever and blocks everything
  behind them (the contract says "don't loop"). Log for diagnosis.
- **240 batches/hour rate limit** is generous next to a WorkManager backoff
  starting at 30s; no client-side limiter needed.

---

## 6. Fix — enrolment (finding 3, the missing first step)

Enrolment is a **user** call (Bearer JWT, existing RTK plumbing), done once
per device after login. The response's `ingestToken` appears **exactly once**
— straight into the native store, never into AsyncStorage or Redux state.

```ts
// src/redux/services/devices.ts
import { api } from './index';
import { NativeModules } from 'react-native';

type EnrollBody = { name: string; imeis: string[]; make?: string; model?: string };
type EnrollResponse = { device: { id: string /* … */ }; ingestToken: string };

const devicesApi = api.injectEndpoints({
  endpoints: build => ({
    enrollDevice: build.mutation<EnrollResponse, { body: EnrollBody }>({
      query: ({ body }) => ({ url: 'v1/devices', method: 'POST', body }),
      async onQueryStarted(_arg, { queryFulfilled }) {
        const { data } = await queryFulfilled;
        // The one moment the token exists in JS. Hand it down and let go.
        await NativeModules.UnlockAttemptModule.storeDeviceIdentity(
          data.device.id,
          data.ingestToken,
        );
      },
    }),

    deviceActivity: build.query<unknown, { id: string }>({
      query: ({ id }) => `v1/devices/${id}/activity`,
    }),
  }),
});

export const { useEnrollDeviceMutation, useDeviceActivityQuery } = devicesApi;
```

Onboarding order that makes the product honest:

1. Login / register (already works).
2. `POST v1/devices` → `storeDeviceIdentity` (above).
3. `requestDeviceAdmin()` → system consent screen (§3.3).
4. Only now show "protected". `isEnrolled && isDeviceAdminActive` is the
   protection status, and the UI should re-check both on every foreground.

Token rotation (`POST v1/devices/:id/token`, owner-initiated) follows the
same path: response → `storeDeviceIdentity` with the new token.

---

## 7. Fix — location permissions (findings 5, 6)

For F1 itself, **no location is needed** — `UNLOCK_FAILED` carries no
coordinates, and the server counts envelopes, not places. Location belongs to
F3 (trail after an episode opens). So:

- **Now:** remove `ACCESS_BACKGROUND_LOCATION` from the manifest until F3
  actually ships the trail. Declaring it unused invites a Play rejection and
  buys nothing.
- **At F3:** request it properly — foreground grant first, then the separate
  background grant (Android 10+ two-step), with the Play in-app disclosure.
  Replace `getLastKnownLocation` with the Fused provider's
  `getCurrentLocation` (add `play-services-location`); receiver-context
  lookups should carry a timeout and treat "no fix" as normal.
- The current `USER_PRESENT`-triggered location logging should go entirely —
  it records *the owner's* movements on every unlock, which is a privacy
  cost with no theft-evidence benefit (the DPIA would have to defend it).

---

## 8. Order of work

1. **Detection** (§3): manifest receiver + `onPasswordFailed` + admin-consent
   flow. Verifiable in a day: fail the PIN on a test device, watch the queue.
2. **Queue** (§4): finalized-at-capture envelopes, ACK-driven removal.
3. **Uploader** (§5): gradle deps, token store, WorkManager worker.
   End-to-end test against the real backend: 3 failed PINs offline → airplane
   mode off → first-alert email arrives, `GET v1/devices/:id/activity` shows 3.
4. **Enrolment UI** (§6): device registration + protection-status screen.
5. **Cleanup** (§7 + retire `UnlockLogger` evidence path, `USER_PRESENT`
   location capture, and the AsyncStorage event store).

Everything above speaks only the surfaces documented in
[f1-client-contract.md](f1-client-contract.md); no backend change is needed
for any of it.
