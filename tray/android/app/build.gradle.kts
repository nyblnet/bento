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
 * Stages everything the app ships that is generated rather than written.
 *
 * Two inputs, for two reasons:
 *
 *  - `tray/bridge.js` is the File System Access polyfill, SHARED with tray/ios.
 *    One copy of semantics whose comments record a bug that wrote users'
 *    documents out as zero bytes; a second copy would be a second chance to
 *    reintroduce it.
 *  - the starter shell is COPIED FROM THE CURRENT BUILD, never committed: a
 *    587KB binary in git would churn on every release. It ages harmlessly — a
 *    new deck self-updates through Bento's normal signed channel the first time
 *    it checks.
 *
 * Mirrors the "Stage starter shell" step in tray/ios/project.yml.
 */
abstract class StageTrayAssets : DefaultTask() {
    @get:InputFiles abstract val bridge: ConfigurableFileCollection
    @get:InputFiles abstract val seed: ConfigurableFileCollection
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun stage() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        bridge.singleFile.copyTo(out.resolve("bridge.js"), overwrite = true)

        // Resolved at EXECUTION time, not configuration time: the seed is a
        // build artefact of a different project, so it routinely appears after
        // this build was last configured.
        val shell = seed.files.firstOrNull { it.exists() }
        if (shell != null) {
            shell.copyTo(out.resolve("starter.bento.html"), overwrite = true)
        } else {
            logger.warn(
                "warning: no starter shell — run 'npm run build:single' in slides/; " +
                    "New document will be unavailable in this build"
            )
        }
    }
}

val stageAssets = tasks.register<StageTrayAssets>("stageTrayAssets") {
    bridge.from(rootProject.file("../bridge.js"))
    seed.from(rootProject.file("../../slides/dist-single/Bento_Slides.bento.html"))
    outputDir.set(layout.buildDirectory.dir("staged-assets"))
}

android {
    namespace = "page.bento.tray"
    compileSdk = 36

    defaultConfig {
        applicationId = "page.bento.tray"
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
}
