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
        versionCode = 11
        versionName = "0.6.0"

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
    // 단위 테스트의 android.jar org.json은 빈 껍데기라, 답변 제어 블록·스트리밍 응답 해석을
    // 검사하려면 실제 구현이 필요하다.
    testImplementation("org.json:json:20180813")
}
