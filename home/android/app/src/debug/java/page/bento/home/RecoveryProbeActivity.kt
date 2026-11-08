// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors

package page.bento.home

import android.app.ActivityManager
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.appcompat.app.AppCompatActivity

/**
 * DEBUG ONLY — the recovery code's Argon2id at the format's full parameters
 * (64 MiB, t = 3), off the main thread, on a real device. Logs the time, the
 * heap the app is allowed, and whether it completed or failed closed.
 *   adb shell am start -n page.bento.home/.RecoveryProbeActivity
 */
class RecoveryProbeActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val am = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        Log.i(TAG, "heap: maxMemory=${Runtime.getRuntime().maxMemory() shr 20} MiB memoryClass=${am.memoryClass} MiB lowRam=${am.isLowRamDevice}")
        Thread {
            repeat(3) { i ->
                val t0 = SystemClock.elapsedRealtime()
                val r = try {
                    Hex.str(Recovery.argon2id(ByteArray(Recovery.CODE_BYTES) { it.toByte() }, ByteArray(Recovery.SALT_LEN) { 7 })).take(16) + "…"
                } catch (e: Recovery.Unavailable) { "UNAVAILABLE: ${e.message}" }
                Log.i(TAG, "run $i: ${SystemClock.elapsedRealtime() - t0} ms -> $r")
            }
            Log.i(TAG, "DONE")
        }.start()
    }
    companion object { const val TAG = "BentoRecoveryProbe" }
}
