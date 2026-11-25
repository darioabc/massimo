pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = "Acme"
include(
    ":app",
    ":core:designsystem",
)
