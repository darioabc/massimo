plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.example.app"
    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(project(":core:designsystem"))
}
