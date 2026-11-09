// The passkey origin probe: a throwaway DEBUG app that runs one Credential
// Manager registration and one assertion for a relying party and shows what
// Android reports (README.md). It is its own application with its own package,
// so the assetlinks statement that admits it names THIS package and never the
// host app's, and nothing in :app depends on it.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "page.bento.probe.origin"
    compileSdk = 36

    defaultConfig {
        applicationId = "page.bento.probe.origin"
        // Android 14 is where Credential Manager is part of the platform, so the
        // Jetpack library reaches Google Password Manager (or any provider)
        // without Play services' client library, which would add a dozen
        // artifacts to verify for a probe.
        minSdk = 34
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }
}

// Debug only. There is no release variant to build, sign or ship: the probe is
// signed with the builder's debug key, which is the key whose fingerprint the
// test relying party's assetlinks.json names.
androidComponents {
    beforeVariants(selector().withBuildType("release")) { it.enable = false }
}

dependencies {
    // Credential Manager. On Android 14+ it calls the platform's
    // CredentialManager, so it needs no Play services client library.
    implementation("androidx.credentials:credentials:1.5.0")

    testImplementation("junit:junit:4.13.2")
}
