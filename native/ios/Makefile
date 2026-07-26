.PHONY: run devices build archive icons deck

## make run               — pick a simulator or device, build, install + launch
## make run device=UDID   — skip the prompt
## make run TEAM=ABC123   — signing team (required for physical devices)
run: deck
	@TEAM=$(TEAM) ./run.sh $(device)

devices:
	@echo "-- Simulators (available):"
	@xcrun simctl list devices available | grep -E 'iPhone|iPad' || true
	@echo "-- Physical devices:"
	@xcrun devicectl list devices 2>/dev/null || true

build: deck
	@xcodebuild -project Bento.xcodeproj -target Bento -configuration Debug \
		-sdk iphonesimulator build CODE_SIGNING_ALLOWED=NO -quiet
	@echo "Built build/Debug-iphonesimulator/Bento.app"

## App Store artifact: make archive TEAM=YOURTEAMID → build/Bento.ipa
archive: deck
	@test -n "$(TEAM)" || { echo "Usage: make archive TEAM=YOURTEAMID"; exit 1; }
	@xcodebuild -project Bento.xcodeproj -scheme Bento -configuration Release \
		-destination "generic/platform=iOS" -archivePath build/Bento.xcarchive \
		archive DEVELOPMENT_TEAM=$(TEAM) -allowProvisioningUpdates -quiet
	@xcodebuild -exportArchive -archivePath build/Bento.xcarchive \
		-exportPath build -exportOptionsPlist ExportOptions.plist \
		-allowProvisioningUpdates -quiet
	@ls -la build/Bento.ipa

icons:
	@python3 ../scripts/gen_icons.py

deck:
	@../scripts/fetch-deck.sh
