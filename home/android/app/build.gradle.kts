import java.util.Properties

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
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun stage() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        bridge.singleFile.copyTo(out.resolve("bridge.js"), overwrite = true)
    }
}

val stageAssets = tasks.register<StageTrayAssets>("stageTrayAssets") {
    bridge.from(rootProject.file("../bridge.js"))
    outputDir.set(layout.buildDirectory.dir("staged-assets"))
}

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

    // Test-only. The indexer is held to the shared corpus in home/fixtures/ by
    // a plain JVM test — no emulator, so there is no excuse not to run it.
    //
    // Gson rather than org.json: Android's org.json is a STUB in unit tests
    // whose methods throw, and whether a real one on the test classpath shadows
    // it is a coin toss. A test that fails for that reason teaches nothing.
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.google.code.gson:gson:2.11.0")
}
