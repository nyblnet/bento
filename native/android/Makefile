JAVA_HOME ?= /opt/homebrew/opt/openjdk@17
ADB       := $(HOME)/Library/Android/sdk/platform-tools/adb

.PHONY: run devices build release bundle icons deck

## make run            — build debug APK, pick a device, install + launch
## make run device=X   — skip the prompt (X = adb serial)
run: deck
	@./run.sh $(device)

devices:
	@$(ADB) devices -l

build: deck
	@JAVA_HOME=$(JAVA_HOME) ./gradlew assembleDebug

release: deck
	@JAVA_HOME=$(JAVA_HOME) ./gradlew assembleRelease
	@ls -la app/build/outputs/apk/release/app-release.apk

## Play Store upload artifact (.aab) — needs keystore.properties for a real signature
bundle: deck
	@JAVA_HOME=$(JAVA_HOME) ./gradlew bundleRelease
	@ls -la app/build/outputs/bundle/release/app-release.aab

icons:
	@python3 ../scripts/gen_icons.py

deck:
	@../scripts/fetch-deck.sh
