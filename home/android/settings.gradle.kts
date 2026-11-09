pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "BentoTray"
include(":app")
// A debug-only probe app with its own package (see originprobe/README.md). Nothing in :app depends on it.
include(":originprobe")
