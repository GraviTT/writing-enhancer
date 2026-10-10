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
        versionCode = 13
        versionName = "0.6.2"

        testInstrumentationRunner = "com.example.writingenhancer.NativeUiQa"
    }

    // 배포용 APK는 GitHub Actions에서 지금 설치된 앱과 같은 서명 키로 만든다(키가 다르면 덮어 설치가 안 된다).
    // 키는 저장소에 두지 않고 WE_SIGNING_STORE_FILE 등 환경 변수로만 받는다. 없으면 이 PC의 기본 디버그 키를 쓴다.
    signingConfigs {
        getByName("debug") {
            System.getenv("WE_SIGNING_STORE_FILE")?.takeIf { it.isNotBlank() }?.let { path ->
                storeFile = file(path)
                storePassword = System.getenv("WE_SIGNING_STORE_PASSWORD")
                keyAlias = System.getenv("WE_SIGNING_KEY_ALIAS")
                keyPassword = System.getenv("WE_SIGNING_KEY_PASSWORD")
            }
        }
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
