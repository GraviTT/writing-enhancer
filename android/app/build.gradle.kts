plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.writingenhancer"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.writingenhancer"
        minSdk = 26
        targetSdk = 35
        versionCode = 9
        versionName = "0.4.3"

        testInstrumentationRunner = "com.example.writingenhancer.NativeUiQa"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        // v0.4.2는 검증된 Android 15 동작 기준을 유지한다. API 36 전환은 별도
        // 권한·오버레이·MediaProjection 호환성 검증과 함께 진행한다.
        disable += "OldTargetApi"
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
