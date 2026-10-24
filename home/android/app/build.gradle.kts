import java.util.Properties

import java.util.Base64
import java.security.AlgorithmParameters
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.KeyFactory
import java.security.spec.ECPublicKeySpec
import java.security.spec.ECPoint
import java.math.BigInteger
import java.security.Signature
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing. Copy keystore.properties.example to keystore.properties and
// fill it in; the file is gitignored, because a keystore path and its passwords
// identify a publisher. Absent, the release build is debug-signed so it stays
// installable while developing — it just cannot go to Play.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

/**
 * Stages the one generated thing the app ships: `home/bridge.js`, the File
 * System Access polyfill SHARED with home/ios. One copy of semantics whose
 * comments record a bug that wrote users' documents out as zero bytes; a second
 * copy would be a second chance to reintroduce it.
 *
 * NO STARTER DECK. It used to stage one here, mirroring home/ios — and that was
 * wrong. Starter decks change often and there are three Bento apps with more
 * coming, so bundling means picking one arbitrarily or shipping several copies
 * of Bento inside the app, each stale from the moment it is built. Measured
 * before it was removed: the single slides seed was 517,161 bytes, 81% of a
 * 630,851-byte release APK.
 *
 * A new document now comes from the signed release channel instead — see
 * `Releases.kt`.
 */
abstract class StageTrayAssets : DefaultTask() {
    @get:InputFiles abstract val bridge: ConfigurableFileCollection
    /** Each app's SIGNED release history, from the published site clone (bento/connect A2, vault). */
    @get:InputFiles @get:Optional abstract val histories: ConfigurableFileCollection
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun stage() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        bridge.singleFile.copyTo(out.resolve("bridge.js"), overwrite = true)
        // releases/<app>/history.json → assets/history/<app>.json. Verified on
        // first read like a fetched copy (ReleaseHistory); it's only the floor.
        for (f in histories.files) if (f.isFile) f.copyTo(out.resolve("history/${f.parentFile.name}.json"), overwrite = true)
    }
}

/**
 * The published site, where each app's signed history lives: BENTO_SITE_DIR, or
 * the sibling clone release.mjs uses. Never a URL fetched at build time.
 */
val siteDir: File = System.getenv("BENTO_SITE_DIR")?.let { file(it) } ?: rootProject.file("../../../bento-site")
val bentoApps = listOf("slides", "spaces", "dash")

val stageAssets = tasks.register<StageTrayAssets>("stageTrayAssets") {
    bridge.from(rootProject.file("../bridge.js"))
    histories.from(bentoApps.map { siteDir.resolve("releases/$it/history.json") }.filter { it.isFile })
    outputDir.set(layout.buildDirectory.dir("staged-assets"))
}

/**
 * RELEASE builds fail closed (vault, security): for every app with a published
 * manifest, the bundled history must exist, verify under the release key, and
 * be at least as new as that manifest. A release APK without one would leave
 * every document UNKNOWN. The key is read from Releases.kt, its one home.
 */
abstract class CheckBundledHistories : DefaultTask() {
    @get:Input abstract val site: Property<String>
    @get:Input abstract val apps: ListProperty<String>
    @get:InputFile abstract val releasesKt: RegularFileProperty
    @get:Input abstract val strict: Property<Boolean>

    @TaskAction
    fun check() {
        val src = releasesKt.get().asFile.readText()
        fun key(n: String) = Regex("""const val $n = "([A-Za-z0-9_-]+)"""").find(src)?.groupValues?.get(1)
            ?: throw GradleException("cannot read $n from Releases.kt")
        val dec = Base64.getUrlDecoder()
        val params = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
        val pub = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(
            ECPoint(BigInteger(1, dec.decode(key("KEY_X"))), BigInteger(1, dec.decode(key("KEY_Y")))), params))
        fun der(raw: ByteArray): ByteArray {
            fun int(b: ByteArray): ByteArray { var i = 0; while (i < b.size - 1 && b[i] == 0.toByte()) i++
                var v = b.copyOfRange(i, b.size); if (v[0].toInt() and 0x80 != 0) v = byteArrayOf(0) + v
                return byteArrayOf(0x02, v.size.toByte()) + v }
            val body = int(raw.copyOfRange(0, 32)) + int(raw.copyOfRange(32, 64))
            return byteArrayOf(0x30, body.size.toByte()) + body
        }
        fun ver(s: String) = s.split(".").map { it.toInt() }
        fun cmp(a: String, b: String): Int { val x = ver(a); val y = ver(b); for (i in 0..2) if (x[i] != y[i]) return x[i] - y[i]; return 0 }
        val root = File(site.get())
        val problems = ArrayList<String>()
        if (!root.isDirectory) problems += "no published site at ${root.path}: set BENTO_SITE_DIR to the bento-site clone"
        else for (app in apps.get()) {
            val manifest = root.resolve("releases/$app/manifest.json")
            if (!manifest.isFile) continue
            val mPayload = (groovy.json.JsonSlurper().parseText(manifest.readText()) as Map<*, *>)["payload"] as String
            val mVersion = (groovy.json.JsonSlurper().parseText(mPayload) as Map<*, *>)["version"] as String
            val hist = root.resolve("releases/$app/history.json")
            if (!hist.isFile) { problems += "no published release history for $app; publish a release first"; continue }
            val env = groovy.json.JsonSlurper().parseText(hist.readText()) as Map<*, *>
            val payload = env["payload"] as String
            val ok = Signature.getInstance("SHA256withECDSA").run {
                initVerify(pub); update(payload.toByteArray(Charsets.UTF_8))
                verify(der(Base64.getMimeDecoder().decode(env["sig"] as String))) }
            if (!ok) { problems += "the published release history for $app does not verify under the release key"; continue }
            @Suppress("UNCHECKED_CAST")
            val releases = (groovy.json.JsonSlurper().parseText(payload) as Map<*, *>)["releases"] as List<Map<*, *>>
            val newest = releases.firstOrNull()?.get("version") as String?
            if (newest == null || cmp(newest, mVersion) < 0)
                problems += "the release history for $app ends at $newest, older than its published manifest ($mVersion); publish the history with the release"
        }
        if (problems.isEmpty()) return
        val msg = "bundled release histories:\n  " + problems.joinToString("\n  ")
        if (strict.get()) throw GradleException(msg) else logger.warn("WARNING (debug build only) $msg")
    }
}

fun checkHistories(name: String, strictCheck: Boolean) = tasks.register<CheckBundledHistories>(name) {
    site.set(siteDir.path)
    apps.set(bentoApps)
    // TEST ONLY: -PhistoryCheckKeySource=<file with KEY_X/KEY_Y> lets the passing
    // path be exercised without the release key's private half. Harmless if
    // misused: the APK verifies its bundled history under its own pinned keys.
    releasesKt.set(file((findProperty("historyCheckKeySource") as String?) ?: "src/main/java/page/bento/home/Releases.kt"))
    strict.set(strictCheck)
}
val checkHistoriesRelease = checkHistories("checkBundledHistoriesRelease", true)
val checkHistoriesDebug = checkHistories("checkBundledHistoriesDebug", false)

android {
    namespace = "page.bento.home"
    compileSdk = 36

    defaultConfig {
        applicationId = "page.bento.home"
        // 26 covers ~98% of devices and is where the storage APIs this app is
        // built on behave consistently. Below it, ACTION_OPEN_DOCUMENT exists
        // but persistable write grants across providers do not.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    if (keystoreProps.isNotEmpty()) {
        signingConfigs {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keystoreProps.isNotEmpty())
                signingConfigs.getByName("release")
            else
                signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

    // Android's own classes are stubs on the JVM rig and throw by default.
    // Returning defaults instead lets Releases' verification sequence — the part
    // most worth testing — run without a device.
    testOptions { unitTests.isReturnDefaultValues = true }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(stageAssets, StageTrayAssets::outputDir)
    }
}

// The JVM rigs read conformance corpora outside this project (home/fixtures,
// kernel/fixtures). Declared as inputs, so a corpus change re-runs the tests
// instead of Gradle calling them up to date and replaying the old result.
tasks.withType<Test>().configureEach {
    inputs.dir(rootProject.file("../fixtures")).withPropertyName("homeFixtures").optional()
    inputs.dir(rootProject.file("../../kernel/fixtures")).withPropertyName("kernelFixtures").optional()
}

// The history check runs before any APK or bundle is assembled: strict for
// release, a visible warning for debug.
tasks.matching { it.name.startsWith("assembleRelease") || it.name.startsWith("bundleRelease") }
    .configureEach { dependsOn(checkHistoriesRelease) }
tasks.matching { it.name == "assembleDebug" || it.name == "installDebug" }
    .configureEach { dependsOn(checkHistoriesDebug) }

dependencies {
    // The ONLY dependency, and it earns its place twice over:
    //
    //  - addDocumentStartJavaScript is the exact equivalent of WebKit's
    //    WKUserScript(.atDocumentStart). Bento decides whether it can save
    //    DURING BOOT, so a bridge injected from onPageStarted/onPageFinished
    //    races the page and loses often enough to matter.
    //  - addWebMessageListener is ORIGIN-SCOPED. addJavascriptInterface, the
    //    dependency-free alternative, injects into every frame in the WebView,
    //    so a remote iframe inside an untrusted document would be handed a
    //    channel that writes the user's file.
    //
    // Both are WebView-side features rather than app-side ones, so the library
    // is a thin façade over what the installed WebView already implements.
    implementation("androidx.webkit:webkit:1.17.0")

    // Material 3, for the documents screen only. Measured cost at the time it
    // was added: +1.26 MB, taking a 122 KB app past 1.3 MB — dominated by
    // resources.arsc, because applying an M3 theme references the library's
    // whole style and attribute graph and resource shrinking cannot prove any
    // of it unused.
    //
    // That ratio was the argument against it while tray was "a thin courier".
    // It is worth paying for two things a hand-rolled theme cannot do at all:
    // DYNAMIC COLOUR (the app adopting the user's wallpaper palette, which is
    // the clearest signal of a modern Android app) and adaptive large-screen
    // behaviour. Both are what Play's editorial surfaces actually reward.
    //
    // EditorActivity deliberately stays off it — a full-screen WebView gains
    // nothing from Material and would only inherit the inflation requirements.
    implementation("com.google.android.material:material:1.12.0")

    // Argon2id for the recovery code (security §35). Pinned exactly; Gradle
    // dependency verification (gradle/verification-metadata.xml) fails the
    // build if the artifact's sha256 ever differs.
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")

    // bento/connect (phase-1 plan A1): BiometricPrompt with a CryptoObject, so the
    // consent key signs only inside an authentication the person just gave.
    implementation("androidx.biometric:biometric:1.1.0")

    // Test-only. The indexer is held to the shared corpus in home/fixtures/ by
    // a plain JVM test — no emulator, so there is no excuse not to run it.
    //
    // Gson rather than org.json: Android's org.json is a STUB in unit tests
    // whose methods throw, and whether a real one on the test classpath shadows
    // it is a coin toss. A test that fails for that reason teaches nothing.
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.google.code.gson:gson:2.11.0")
}
