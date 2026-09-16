package com.pulsedial.donor

import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class OverlayPermissionModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var mediaPlayer: MediaPlayer? = null

    override fun getName(): String = "OverlayPermission"

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        stopSoundInternal()
    }

    private fun stopSoundInternal() {
        try {
            mediaPlayer?.let { player ->
                if (player.isPlaying) {
                    player.stop()
                }
                player.reset()
                player.release()
            }
        } catch (_: Exception) {
        } finally {
            mediaPlayer = null
        }
    }

    @ReactMethod
    fun playEmergencyAlertSound(promise: Promise) {
        try {
            stopSoundInternal()

            val rawResId = reactContext.resources.getIdentifier(
                "emergency_siren",
                "raw",
                reactContext.packageName
            )

            val player = if (rawResId != 0) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    val audioAttrs = AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                    MediaPlayer.create(reactContext, rawResId, audioAttrs, 0)
                } else {
                    MediaPlayer.create(reactContext, rawResId)
                }
            } else {
                val alarmUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                MediaPlayer.create(reactContext, alarmUri)
            }

            if (player != null) {
                player.isLooping = true
                player.setVolume(1.0f, 1.0f)
                player.start()
                mediaPlayer = player
                promise.resolve(true)
            } else {
                promise.resolve(false)
            }
        } catch (e: Exception) {
            try {
                val fallbackUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                val fallbackPlayer = MediaPlayer.create(reactContext, fallbackUri)
                if (fallbackPlayer != null) {
                    fallbackPlayer.isLooping = true
                    fallbackPlayer.setVolume(1.0f, 1.0f)
                    fallbackPlayer.start()
                    mediaPlayer = fallbackPlayer
                    promise.resolve(true)
                    return
                }
            } catch (_: Exception) {}
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun stopEmergencyAlertSound(promise: Promise) {
        try {
            stopSoundInternal()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun canDrawOverlays(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                promise.resolve(Settings.canDrawOverlays(reactContext))
            } else {
                promise.resolve(true)
            }
        } catch (e: Exception) {
            promise.reject("ERR_OVERLAY", e.message)
        }
    }

    @ReactMethod
    fun openOverlaySettings(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${reactContext.packageName}")
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(intent)
                promise.resolve(true)
            } else {
                promise.resolve(true)
            }
        } catch (e: Exception) {
            try {
                val fallbackIntent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:${reactContext.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(fallbackIntent)
                promise.resolve(true)
            } catch (fallbackEx: Exception) {
                promise.reject("ERR_OPEN_SETTINGS", fallbackEx.message)
            }
        }
    }

    @ReactMethod
    fun bringAppToForeground(promise: Promise) {
        try {
            val intent = Intent(reactContext, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERR_FOREGROUND", e.message)
        }
    }
}
