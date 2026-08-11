---
Title: Carvera Community Controller releases (v2.2.0-RC1 Z1 support)
Ticket: MZ1-001
Status: active
Topics:
    - research
    - protocol
    - cnc
DocType: reference
Intent: long-term
Owners: []
RelatedFiles: []
ExternalSources:
    - https://github.com/Carvera-Community/Carvera_Controller/releases
Summary: "Release notes proving initial Z1 support and the Z1-specific fixes."
LastUpdated: 2026-08-11T16:42:27-04:00
WhatFor: "Raw upstream source capture collected during MZ1-001 protocol research."
WhenToUse: "When verifying a claim in the design guide against the original upstream page."
---

## Release list

[dev](https://github.com/Carvera-Community/Carvera_Controller/releases/tag/dev) Pre-release

Pre-release

## Welcome to the Dev Build Release Page for Carvera Controller Community!

## What is a Dev Build?

Dev builds are the latest versions of Carvera Controller Community, automatically compiled after every new commit to the `develop` branch. This means that each build incorporates the most recent changes and improvements. While these builds offer a glimpse into the ongoing development of Carvera Controller, keep in mind that they are still works in progress and may contain bugs or unstable features.

## Download Instructions:

1. Select the version that corresponds to your operating system.
2. Download and install/run the build.
3. Dive into the newest features and improvements!

## Please Note:

- Dev builds are developmental and may contain bugs.
- Your feedback is crucial. Please report any issues or suggestions on our GitHub page.

## Release notes

The follow changes are present in the dev build:

- Change: Moved tools visibility controls to the color scheme panel

[v2.2.0-RC1](https://github.com/Carvera-Community/Carvera_Controller/releases/tag/v2.2.0-RC1) Pre-release

Pre-release

[SergeBakharev](https://github.com/SergeBakharev) released this 04 Aug 22:53

[v2.2.0-RC1](https://github.com/Carvera-Community/Carvera_Controller/tree/v2.2.0-RC1)

[`777482a`](https://github.com/Carvera-Community/Carvera_Controller/commit/777482a6c1d96ae59bbac7119cf708414fb2c02e)

This is a Release Candidate 1 for Carvera Community Controller v2.2.0c. We ask only those already confident with their machines run this RC, and if discovered any issues to please post in #mods on the Makera or Carvera Community Projects Discords.

## What's Changed

- Enhancement: Read tool definitions from post-processor outputs and use them in the G-code viewer
- Enhancement: Add multi-select to the remote file browser
- Enhancement: Display error message in halt popup. Requires halt errors to start with "ERROR: " in the firmware
- Enhancement: Add popup notice when using stock firmware instead of the Community Firmware
- Enhancement: Improvements to saving changes in settings menu
- Enhancement: Add syntax highlighting to the file viewer
- Enhancement: Only re-render the gcode viewer scene if something has changed
- Enhancement: Add Facing wizard
- Enhancement: Support gamepads as pendants
- Enhancement: Added iPhone support
- Enhancement: Improved gcode viewer toolbar buttons layout
- Enhancement: Show current config probe tip diameter in probing panels
- Enhancement: Add CMM-like functionality. This is a dedicated UI for using the 3D Probe to created 2D designs from probed geometry
- Enhancement: Show tool change markers on the playback progress bar
- Enhancement: Add grid visualization, ortho projection, view cube and color schemes selector to the gcode viewer
- Enhancement: Detect WHB04 pendant permission errors instead of silently ignoring pendant
- Enhancement: New M469.6 4th Axis calibration routine finds the true 4th axis center now replaces the previous M469.4 4th axis head stock calibration
- Enhancement: Advanced TLO Calibration option. Here you can set the offset to use from tool setter, and/or the number of repeat probings to use
- Enhancement: Added a warning popup if the controller version is lower than the firmware. This is not a supported config
- Enhancement: Added Auto Ext. Out toggle to spindle dropdown and Config and Run screen. This can be used to automatically run a vacuum or compressor when the spindle is running
- Enhancement: Autodetect Smoothie vs Makera communication protocol on connect and use it for the session
- Enhancement: Show a connecting progress popup while opening a USB device
- Enhancement: Log connect and manual disconnect with the connection method and address
- Enhancement: Add a "Network..." option under Scan Wi-Fi in the connection dropdown to enter a machine network address
- Enhancement: Reconnect supports USB as well as WiFi. Configure preferred method for app-launch auto-connect
- Enhancement: added green question mark help buttons to the UI that link to the relevant documentation page
- Enhancement: Block sending the `reset` command over USB and show a popup directing the user to use the power switch instead
- Enhancement: Initial Z1 support
- Enhancement: Resume-at-line warns when the recovery sequence is missing a tool change, feed rate, or spindle speed
- Enhancement: Live camera view for the Makera Z1. Resolution can be changed while streaming, and brightness, contrast and gamma adjusted while viewing
- Fixed: Restore Keyboard Jogging state after Probing Popup is closed
- Fixed: Confirmation dialogs no longer retain expanded layouts from laser and resume warnings
- Fixed: Repeated firmware checks now happen just once
- Fixed: UI widget updates from the SerialMonitor() now dispatched via the main thread. This should reduce the number of RecycleView related crashes
- Fixed: Spindle temp reporting when running Analog type spindle without rpm reporting
- Fixed: Fit the gcode viewer to the path's bounding box instead of its max X/Y/Z
- Fixed: Last character of the current file was sometimes missing in the file viewer
- Fixed: Disable trackpad being treated as touchscreen on Linux
- Fixed: Jogging was incorrectly blocked/allowed under certain conditions
- Fixed: GCode parser: Do not set tool number to 7 after M321
- Fixed: Fix potential crashes due to an undefined FuncSetting key"
- Fixed: Fix incorrect "No Pendant" in UI when pendant is working
- Fixed: Fix invalid initial coordinates when resuming in the middle of a modal command
- Fixed: 3D Visualisation of gcode movement would always show the initial movement as originating from the WCS Origin, this doesn't match reality. Now the Visualisation correctly shows the line as originating from above the first movement command at the configured clearance\_z (default of MCS Z-3)
- Fixed: When a USB connection was lost, the popup had a non-functioning reconnect button
- Fixed: When connecting over USB the UI thread would freeze while it was opening the device
- Fixed: USB higher-baud upgrade failed on Makera protocol (trailing newline in framed commands, race with config download, host baud switch). Upgrade now runs after config sync and verifies the link
- Fixed: Config download / MD5-match cache path could fail to load settings and block later USB baud upgrade
- Fixed: Status and diagnose parsers mishandled trailing newlines in Makera payloads (e.g. RSSI parse warnings)
- Fixed: Fresh USB-only connects could immediately show "Connection to machine lost" while the machine was still booting after DTR reset; "Connection to machine lost" is now also logged
- Fixed: Elapsed and remaining job timers now pause while playback is paused
- Fixed: Sanitize missing or malformed spindle values before updating the WHB04 display
- Fixed: Treat blank conditionally required X/Y probing inputs as missing
- Fixed: Resume-at-line restores spindle speed from zero-padded M03 commands
- Fixed: Ignore unknown WHB04 button values without reconnecting or dropping valid paired inputs
- Fixed: Resume-at-line restores feed rates from standalone and tightly packed F words before recovery moves
- Fixed: Resume-at-line no longer treats the non-modal G53 command as the active work coordinate system
- Fixed: Reject downloads whose content does not match the machine-provided MD5. Skip MD5 check when none is available, and defer.lz checks until after decompress
- Fixed: Ensure complete XMODEM packets are written over Wi-Fi
- Fixed: Confirm popup content now scrolls and sizes to its text
- Fixed: Dragging a slider that floats over the gcode viewer also orbited or panned the view behind it
- Fixed: On the Makera Z1 firmware every download returns same placeholder MD5 hash instead of a digest failing the MD5 check
- Change: Misleading "Download canceled by Controller!" MDI message is suppressed, in logs a message is recorded that cached version of the config.txt was used
- Change: Remove remaining "Can not load config, Key:" messages from the MDI
- Change: Resume playback will now use gcode loaded in the controller instead of cached local file
- Change: Upgrade screen now will show the letter "c" at the end of the current firmware version if it's present. This indicates that it's Community firmware
- Change: Auto-connect on app launch now is only performed if auto-reconnect is enabled
- Change: Reconnect uses the last successful connection method. On fresh app launch it uses the configured preferred connection method
- Change: USB devices in connection dropdown are filtered to only show devices specifically with the FTDI chip found on the Makera machines
- Change: USB devices are now selected and stored by stable VID:PID:serial identity (instead of generic COM path)
- Change: Machine Light, and Ext. Control buttons now usable while machine is in Run, Tool or Paused states
- Change: Text properly fits into popup boxes based on actual box size

## New Contributors

- [@software-2](https://github.com/software-2) made their first contribution in [#562](https://github.com/Carvera-Community/Carvera_Controller/pull/562)
- [@waynepiekarski](https://github.com/waynepiekarski) made their first contribution in [#588](https://github.com/Carvera-Community/Carvera_Controller/pull/588)
- [@rbeard-ewa](https://github.com/rbeard-ewa) made their first contribution in [#621](https://github.com/Carvera-Community/Carvera_Controller/pull/621)
- [@danilius](https://github.com/danilius) made their first contribution in [#626](https://github.com/Carvera-Community/Carvera_Controller/pull/626)
- [@f355](https://github.com/f355) made their first contribution in [#627](https://github.com/Carvera-Community/Carvera_Controller/pull/627)
- [@michael-ring](https://github.com/michael-ring) made their first contribution in [#693](https://github.com/Carvera-Community/Carvera_Controller/pull/693)
- [@righteousgambit](https://github.com/righteousgambit) made their first contribution in [#684](https://github.com/Carvera-Community/Carvera_Controller/pull/684)
- [@MichaelLevAstro](https://github.com/MichaelLevAstro) made their first contribution in [#694](https://github.com/Carvera-Community/Carvera_Controller/pull/694)

## Contributors

Thank you to the developers that worked on this release:

- [@faecorrigan](https://github.com/faecorrigan)
- [@WARIO2412](https://github.com/WARIO2412)
- [@SergeBakharev](https://github.com/SergeBakharev)
- [@acj](https://github.com/acj)
- [@Lyrkan](https://github.com/Lyrkan)

**Full Changelog**: [v2.1.0...v2.2.0-RC1](https://github.com/Carvera-Community/Carvera_Controller/compare/v2.1.0...v2.2.0-RC1)

[SergeBakharev](https://github.com/SergeBakharev) released this 08 Apr 10:00

[v2.1.0](https://github.com/Carvera-Community/Carvera_Controller/tree/v2.1.0)

[`3135105`](https://github.com/Carvera-Community/Carvera_Controller/commit/313510521bee321e6f5995e6395dda8efff4a26f)

Hello,  
This is the stable version of the Carvera Community Controller 2.1.0

## What's Changed Since Last Stable Release (2.0.0)

- Enhancement: Support connecting to hidden wifi networks
- Enhancement: Upload and select a file when it's double clicked in the local file browser
- Enhancement: Select a file when it's double clicked in the remote file browser
- Enhancement: Automatically connect to the machine on startup if its wifi address is configured
- Enhancement: CI workflow for building iOS app
- Enhancement: Added support sending multiple MDI commands at once
- Enhancement: Pressing the up arrow when in the MDI input box re-populates the input with the last send command
- Enhancement: Added "Always on top" Controller config option to keep the application window stay above other windows
- Enhancement: Added option to resume playback of a gcode file at a particular line on the "Config and Run" screen
- Enhancement: Added context menu when right clicking a line in a Gcode file. Current option is only to select the line for resume playback. On touch screen long pressing on a line also brings up this context menu.
- Enhancement: Previewing gcode files synchronises the line selection in the file view with the progress slider
- Enhancement: If machine is halted during gcode file playback or stopped, populate the last run line number into the resume playback inputbox
- Enhancement: Back up the machine's config files to the computer where the Controller is running
- Enhancement: Updated the wcs table page to include a description field for the different wcs
- Enhancement: Show popup with suggestions when trying to start probing without a probing tool selected
- Enhancement: Support inverted y-axis jogging controls to match intuition for some users
- Enhancement: Add SMW fixture plate background images for the Carvera Air
- Enhancement: Added debug logging of full sent/recieved content as a config option
- Enhancement: Time remaining is now based on a estimate of the toolpath movements instead of basing on number of lines executed/duration. This adds extra parsing time after selecting a file. This new functionality can be disabled in Controller settings to return to using the time estimates that come from the machine firmware
- Enhancement: Added debug logging of full sent/received content as a config option
- Enhancement: Support recalling multiple commands from MDI history with up/down arrow keys
- Enhancement: Add keyboard shortcuts for launching settings (ctrl+,) and navigating to MDI (ctrl+m)
- Enhancement: Restore the previously-loaded background image in Config and Run
- Enhancement: Support increasing USB connection speed if the firmware is >= 2.1.0c. Enable feature and set baud rate in Controller settings
- Enhancement: Update UI based on machines feature set not on machine model
- Enhancement: Added ability to use the toolchange popups of the AIR for manual toolchanges with an ATC
- Enhancement: Added config settings for spindle Max RPM
- Enhancement: Added a UI prompt if gcode cannot be visualised. File is still allowed to run but features dependent on visualisation will be disabled.
- Enhancement: Added UI probing section for 4th axis. Currently the only option is stock leveling (M465.1)
- Enhancement: Added ability to configure the TLO reference position. Defaults to -115.34 which is an empty collet on C1 and CA1
- Enhancement: Add right-click menu option to clear resume-at-line setting
- Enhancement: Display collet information in the manual toolchange popup, when using S1-S6 parameter for M6 toolchanges
- Fixed: Improved Overheat/Too Cold/temp undefined warning text
- Fixed: Improved reliability of the app cleanup/exit handler by switching to the Kivy on\_request\_close() hook.
- Fixed: MDI scrolling behavior was sometimes quirky when new text was added
- Fixed: Prevent keyboard jog when MDI text box has focus
- Fixed: When uploading firmware, the "Download" and "Upload and select" buttons were visible
- Fixed: The background image for the CA1 in the configure-and-run preview screen was sized incorrectly causing scaling issues
- Fixed: Only move once per keypress in step mode when keyboard jogging
- Fixed: Pendant A axis position displayed was in MCS not WCS
- Fixed: In the file manager, Upload and View buttons should be disabled until a file is selected
- Fixed: missing config settings would disconnect the controller, now issues a warning
- Fixed: Set A was incorrectly performing a RapidA movement instead of setting the WCS
- Fixed: The 4th axis probing sequence for the z offset calibration (M469.5) was not passing pin diameter input through to the machine
- Fixed: Viewing Gcode would cause an app crash when not connected to a machine
- Fixed: Jogging buttons in the probing screen was using the step size from the main control panel not the probing screen
- Fixed: Use embedded CA certs from certifi instead of depending on PyInstaller/OS
- Fixed: The input of the rotation value was cut to one decimal in the wcs table. Now uses 3 decimals.
- Fixed: Disable probing dialog's step size text boxes when in continuous jog mode
- Fixed: Connecting used to clear the selected\_local\_filename of gcode file which would break resume-at-line functionality after a reconnect. Now it's retained if reconnecting to the same machine, and cleared only if connecting to a different machine
- Fixed: Using resume-at-line functionality silently used to break if the cached gcode file has been deleted while the app was running. Now raises a UI error prompt.
- Change: Scan Margin, Auto Z Probe default to disabled to encourage novice users to not "one-shot" setup.
- Change: Ctrl + Enter needs to be pressed to send an MDI command now. Pressing enter will simply add a new line to the input box.
- Change: After loading a program, the gcode view scrolls to the top of the file
- Change: Packaging assets are now in `assets/packaging` to create space for `assets/design` and other types of assets
- Change: Improved logging of parser errors of machine responses
- Change: On USB-serial connect, clear machine's receive buffer by sending "\\n;\\n"
- Change: Probing screen overhauled for better visual clarity, defaults to save WCS on all probing operations
- Change: added keyboard and pendant jogging modes to probing popup. Keyboard jogging is disabled when first opening the popup or clicking into any text field
- Change: Values in the top bar buttons now shrink in font\_size if just a bit too big (by up to 20%), and if still overflowing perform a marquee scroll
- Change: Workspace Descriptions are now shown (if set) instead of G54 etc
- Change: Laser and Spindle Top Bar buttons are now combined, and laser mode enable button added to Tool drop down to switch between them
- Change - Added the instant spindle speed and feed rate overrides to the relevant +/- buttons and gated them behind a controller setting and firmware version 2.1.0c

## What's Changed since v2.1.0-RC1:

- Enhancement: Add right-click menu option to clear resume-at-line setting
- Enhancement: Display collet information in the manual toolchange popup, when using S1-S6 parameter for M6 toolchanges
- Fixed: The 4th axis probing sequence for the z offset calibration (M469.5) was not passing pin diameter input through to the machine
- Fixed: Viewing Gcode would cause an app crash when not connected to a machine
- Fixed: Jogging buttons in the probing screen was using the step size from the main control panel not the probing screen
- Fixed: Use embedded CA certs from certifi instead of depending on PyInstaller/OS
- Fixed: The input of the rotation value was cut to one decimal in the wcs table. Now uses 3 decimals.
- Fixed: Disable probing dialog's step size text boxes when in continuous jog mode
- Fixed: Connecting used to clear the selected\_local\_filename of gcode file which would break resume-at-line functionality after a reconnect. Now it's retained if reconnecting to the same machine, and cleared only if connecting to a different machine
- Fixed: Using resume-at-line functionality silently used to break if the cached gcode file has been deleted while the app was running. Now raises a UI error prompt.

## Contributors

Thank you to the developers that worked on this release:

- [@faecorrigan](https://github.com/faecorrigan)
- [@WARIO2412](https://github.com/WARIO2412)
- [@SergeBakharev](https://github.com/SergeBakharev)
- [@acj](https://github.com/acj)
- [@CCS86](https://github.com/CCS86)

[v2.1.0-RC1](https://github.com/Carvera-Community/Carvera_Controller/releases/tag/v2.1.0-RC1) Pre-release

Pre-release

[SergeBakharev](https://github.com/SergeBakharev) released this 21 Feb 21:49

[v2.1.0-RC1](https://github.com/Carvera-Community/Carvera_Controller/tree/v2.1.0-RC1)

[`8592170`](https://github.com/Carvera-Community/Carvera_Controller/commit/8592170f6e373ecc36bb7b96451662a163228571)

This is a Release Candidate 1 for Carvera Community Controller v2.1.0. We ask only those already confident with their machines run this RC, and if discovered any issues to please post in #mods on the Makera or Carvera Community Projects Discords.

## What's Changed

- Enhancement: Support connecting to hidden wifi networks
- Enhancement: Upload and select a file when it's double clicked in the local file browser
- Enhancement: Select a file when it's double clicked in the remote file browser
- Enhancement: Automatically connect to the machine on startup if its wifi address is configured
- Enhancement: CI workflow for building iOS app
- Enhancement: Added support sending multiple MDI commands at once
- Enhancement: Pressing the up arrow when in the MDI input box re-populates the input with the last send command
- Enhancement: Added "Always on top" Controller config option to keep the application window stay above other windows
- Enhancement: Added option to resume playback of a gcode file at a particular line on the "Config and Run" screen
- Enhancement: Added context menu when right clicking a line in a Gcode file. Current option is only to select the line for resume playback. On touch screen long pressing on a line also brings up this context menu.
- Enhancement: Previewing gcode files synchronises the line selection in the file view with the progress slider
- Enhancement: If machine is halted during gcode file playback or stopped, populate the last run line number into the resume playback inputbox
- Enhancement: Back up the machine's config files to the computer where the Controller is running
- Enhancement: Updated the wcs table page to include a description field for the different wcs
- Enhancement: Show popup with suggestions when trying to start probing without a probing tool selected
- Enhancement: Support inverted y-axis jogging controls to match intuition for some users
- Enhancement: Add SMW fixture plate background images for the Carvera Air
- Enhancement: Added debug logging of full sent/recieved content as a config option
- Enhancement: Time remaining is now based on a estimate of the toolpath movements instead of basing on number of lines executed/duration. This adds extra parsing time after selecting a file. This new functionality can be disabled in Controller settings to return to using the time estimates that come from the machine firmware
- Enhancement: Added debug logging of full sent/received content as a config option
- Enhancement: Support recalling multiple commands from MDI history with up/down arrow keys
- Enhancement: Add keyboard shortcuts for launching settings (ctrl+,) and navigating to MDI (ctrl+m)
- Enhancement: Restore the previously-loaded background image in Config and Run
- Enhancement: Support increasing USB connection speed if the firmware is >= 2.1.0c. Enable feature and set baud rate in Controller settings
- Enhancement: Update UI based on machines feature set not on machine model
- Enhancement: Added ability to use the toolchange popups of the AIR for manual toolchanges with an ATC
- Enhancement: Added config settings for spindle Max RPM
- Enhancement: Added a UI prompt if gcode cannot be visualised. File is still allowed to run but features dependent on visualisation will be disabled.
- Enhancement: Added UI probing section for 4th axis. Currently the only option is stock leveling (M465.1)
- Enhancement: Added ability to configure the TLO reference position. Defaults to -115.34 which is an empty collet on C1 and CA1
- Fixed: Improved Overheat/Too Cold/temp undefined warning text
- Fixed: Improved reliability of the app cleanup/exit handler by switching to the Kivy on\_request\_close() hook.
- Fixed: MDI scrolling behavior was sometimes quirky when new text was added
- Fixed: Prevent keyboard jog when MDI text box has focus
- Fixed: When uploading firmware, the "Download" and "Upload and select" buttons were visible
- Fixed: The background image for the CA1 in the configure-and-run preview screen was sized incorrectly causing scaling issues
- Fixed: Only move once per keypress in step mode when keyboard jogging
- Fixed: Pendant A axis position displayed was in MCS not WCS
- Fixed: In the file manager, Upload and View buttons should be disabled until a file is selected
- Fixed: missing config settings would disconnect the controller, now issues a warning
- Fixed: Set A was incorrectly performing a RapidA movement instead of setting the WCS
- Change: Scan Margin, Auto Z Probe default to disabled to encourage novice users to not "one-shot" setup.
- Change: Ctrl + Enter needs to be pressed to send an MDI command now. Pressing enter will simply add a new line to the input box.
- Change: After loading a program, the gcode view scrolls to the top of the file
- Change: Packaging assets are now in `assets/packaging` to create space for `assets/design` and other types of assets
- Change: Improved logging of parser errors of machine responses
- Change: On USB-serial connect, clear machine's receive buffer by sending "\\n;\\n"
- Change: Probing screen overhauled for better visual clarity, defaults to save WCS on all probing operations
- Change: added keyboard and pendant jogging modes to probing popup. Keyboard jogging is disabled when first opening the popup or clicking into any text field
- Change: Values in the top bar buttons now shrink in font\_size if just a bit too big (by up to 20%), and if still overflowing perform a marquee scroll
- Change: Workspace Descriptions are now shown (if set) instead of G54 etc
- Change: Laser and Spindle Top Bar buttons are now combined, and laser mode enable button added to Tool drop down to switch between them
- Change - Added the instant spindle speed and feed rate overrides to the relavent +/- buttons and gated them behind a controller setting and firmware version 2.1.0c

## Contributors

Thank you to the developers that worked on this release:

- [@faecorrigan](https://github.com/faecorrigan)
- [@SergeBakharev](https://github.com/SergeBakharev)
- [@WARIO2412](https://github.com/WARIO2412)
- [@acj](https://github.com/acj)
- [@Lyrkan](https://github.com/Lyrkan)

**Full Changelog**: [v2.0.0...v2.1.0-RC1](https://github.com/Carvera-Community/Carvera_Controller/compare/v2.0.0...v2.1.0-RC1)

[v2.0.0](https://github.com/Carvera-Community/Carvera_Controller/releases/tag/v2.0.0)

[SergeBakharev](https://github.com/SergeBakharev) released this 12 Dec 21:46

[v2.0.0](https://github.com/Carvera-Community/Carvera_Controller/tree/v2.0.0)

[`47fea6b`](https://github.com/Carvera-Community/Carvera_Controller/commit/47fea6b3ded18bd11ca80fea30ac1cdb6b3f1481)

Hello,  
This is the stable version of the Carvera Community Controller 2.0.0

## What's Changed since v2.0.0-RC2:

- Fixed: Closing the Controller after auto-reconnection canceled causes the app to freeze
- Fixed: App crashes if machine connection is lost while the controller attempts to query the the Diagnostic info
- Fixed: Probing popup shouldn't be accessible when playback is suspended
- Fixed: UI state for manual MDI text box and the Send button can be incorrect and make MDI seem broken
- Fixed: Hard-coded search paths in Xcode project for iOS app
- Fixed: The H parameter in A axis Y calibration and graphic was wrong, the probe depth is set via E
- Fixed: Scaling of the UI in Android no longer cuts off menu button on displays with 5:3 aspect ratio
- Change: Intel MacOS minimum version increased to MacOS-14 (Sonoma). Previous versions might work, but will be unsupported

## What's Changed Since Last Stable Release (0.10.1)

There is a [Community documentation site](https://carvera-community.gitbook.io/docs/) being updated with all existing and new features.

- Enhancement: Continuous jog mode support. Community firmware > 2.0.0c is required for this feature.
- Enhancement: Configurable Macro buttons added to the Control UI screen. Configure the macros in Controller Settings
- Enhancement: Auto-Reconnect functionality with configurable delay, and attempts
- Enhancement: Add Online Documentation link to Function dropdown
- Enhancement: WBH04 Pendant step size option "Lead" scales the feedrate to the rotational wheel speed of the pendant
- Enhancement: MDI sent/recived now logged to log file (if enabled)
- Enhancement: New HALT message when a 3D probe crash was detected
- Enhancement: Controller option "Allow Jogging When Machine is Running". This allows advanced users to jog the spindle manually while it is spinning enabling manual milling operations.
- Enhancement: Max FPS can now be configured in the Controller settings
- Enhancement: Tooltips can be turned on and off in the Controller settings
- Enhancement: Tooltip delay before displaying can be configured in the controller settings
- Enhancement: Probe Tip Calibration screens complete and functional
- Enhancement: Probing popup confirm dialog now says close instead of cancel
- Enhancement: Probing popup confirm dialog now displays relavent information from the MDI
- Enhancement: Added more info button to probing popup that directs the user to the relavent gitbook page
- Enhancement: Added machine position calibration screen
- Fixed: Closing the Controller after auto-reconnection canceled causes the app to freeze
- Fixed: App crashes if machine connection is lost while the controller attempts to query the the Diagnostic info
- Fixed: Probing popup shouldn't be accessible when playback is suspended
- Fixed: UI state for manual MDI text box and the Send button can be incorrect and make MDI seem broken
- Fixed: Hard-coded search paths in Xcode project for iOS app
- Fixed: The H parameter in A axis Y calibration and graphic was wrong, the probe depth is set via E
- Fixed: Scaling of the UI in Android no longer cuts off menu button on displays with 5:3 aspect ratio
- Fixed: Probing jog buttons follow same behavior for on\_press and on\_release as main jogging buttons
- Fixed: Keyboard jogging of Z-axis in Step Mode uses the selected Z step size, accidently selecting X/Y previously.
- Fixed: 3D Visualization now rendered based on the configured target from the Max FPS setting instead of hard coded to 60.
- Fixed: Tooltips are now disabled when the source object is not in the active screen or popup
- Fixed: Autoreconnection failure dialog now only shown on failure of last attempt, previously was shown on every attempt
- Fixed: The probing start dialog can now be closed if the machine halts while probing
- Fixed: Top bar buttons minimum size increased to ensure sufficient space for position values up to 999.999 without truncating
- Fixed: Including win32timezone for Windows builds. Fixes Play background images custom folder
- Fixed: New installs would crash when no previous folder available to open in file browser
- Fixed: Autoreconnect attempted to connect over network for dropped USB-Serial connections, for now we have made autoreconnect a network connection only feature
- Fixed: HIDAPI Library for MacOS now embedded into MacOS releases, this enables the use of the WiXHC WHB04B Pendant on MacOS using the.dmg release artifacts
- Fixed: Simulated multitouch (red dots) disabled if running controller on non-mobile OS
- Fixed: crash in recycle view when the data is updated at the same time as being read
- Fixed: Upload-and-Select button is now disabled until a file is selected
- Fixed: WBH04 Pendant Macro-10 should be treated as an action button
- Fixed: Better handling of machine diagnostic output to support analogue mode spindles
- Fixed: XYZ Block probing UI was running the set offset gcode G10L2 instead of M495.3
- Change: Intel MacOS minimum version increased to MacOS-14 (Sonoma). Previous versions might work, but will be unsupported
- Change: Jogging option buttons consolidated and always displayed
- Change: Default jog speed is "max" (10k mm/min). Pendant Jog speed uses configured the global jog speed
- Change: Jog buttons act now on\_press instead of on\_release
- Change: Probing cancel button becomes halt button if machine is moving
- Change: Machine heartbeat is now 5s to be a bit more responsive on disconnects
- Change: Light toggle button initial state is set on connect
- Change: Controller logging options now available in settings. Default log\_level is info and log to file is enabled.
- Change: SafeZ positions are now 2mm from the home positions to provide clearence for users of x-sag compensation
- Change: Pushing Cancel on the Changing Tool popup stops g-code playback. Community firmware > 2.0.0c is required for this feature.
- Change: Added config item to skip moving to path origin on gcode playback start. Community firmware > 2.0.0c is required for this feature.

## Contributors

Thank you to the developers that worked on this release:

- [@faecorrigan](https://github.com/faecorrigan)
- [@acj](https://github.com/acj)
- [@SergeBakharev](https://github.com/SergeBakharev)
- [@WARIO2412](https://github.com/WARIO2412)

New version milestone!  
We feel that so much functionality has been added to the Community Firmware and Controller beyond the OEM that the version 2.0.0 milestone is warranted. Please note that this is still an incremental release and there are no breaking changes from the previous versions.

[v2.0.0-RC2](https://github.com/Carvera-Community/Carvera_Controller/releases/tag/v2.0.0-RC2)

[SergeBakharev](https://github.com/SergeBakharev) released this 29 Sep 08:02

[v2.0.0-RC2](https://github.com/Carvera-Community/Carvera_Controller/tree/v2.0.0-RC2)

[`7491ebb`](https://github.com/Carvera-Community/Carvera_Controller/commit/7491ebb14c6f5083620e790277a713b48583cacd)

## What's Changed

- Enhancement: Controller option "Allow Jogging When Machine is Running". This allows advanced users to jog the spindle manually while it is spinning enabling manual milling operations.
- Enhancement: Max FPS can now be configured in the Controller settings
- Enhancement: Tooltips can be turned on and off in the Controller settings
- Enhancement: Tooltip delay before displaying can be configured in the controller settings
- Enhancement: Probe Tip Calibration screens complete and functional
- Enhancement: Probing popup confirm dialog now says close instead of cancel
- Enhancement: Probing popup confirm dialog now displays relavent information from the MDI
- Enhancement: Added more info button to probing popup that directs the user to the relavent gitbook page
- Enhancement: Added machine position calibration screen
- Fixed: Probing jog buttons follow same behavior for on\_press and on\_release as main jogging buttons
- Fixed: Keyboard jogging of Z-axis in Step Mode uses the selected Z step size, accidently selecting X/Y previously.
- Fixed: 3D Visualization now rendered based on the configured target from the Max FPS setting instead of hard coded to 60.
- Fixed: Tooltips are now disabled when the source object is not in the active screen or popup
- Fixed: Autoreconnection failure dialog now only shown on failure of last attempt, previously was shown on every attempt
- Fixed: The probing start dialog can now be closed if the machine halts while probing
- Fixed: Top bar buttons minimum size increased to ensure sufficient space for position values up to 999.999 without truncating
- Fixed: Including win32timezone for Windows builds. Fixes Play background images custom folder
- Fixed: New installs would crash when no previous folder availiable to open in file browser
- Fixed: Autoreconnect attempted to connect over network for dropped USB-Serial connections, for now we have made autoreconnect a network connection only feature
- Fixed: HIDAPI Library for MacOS now embedded into MacOS releases, this enables the use of the WiXHC WHB04B Pendant on MacOS using the.dmg release artifacts
- Fixed: Simulated multitouch (red dots) disabled if running controller on non-mobile OS

## Contributors

Thank you to the developers that worked on this release:

- [@acj](https://github.com/acj)
- [@faecorrigan](https://github.com/faecorrigan)
- [@SergeBakharev](https://github.com/SergeBakharev)

[v2.0.0-RC1](https://github.com/Carvera-Community/Carvera_Controller/releases/tag/v2.0.0-RC1) Pre-release

Pre-release

[SergeBakharev](https://github.com/SergeBakharev) released this 30 Aug 10:58

[v2.0.0-RC1](https://github.com/Carvera-Community/Carvera_Controller/tree/v2.0.0-RC1)

[`f1d0274`](https://github.com/Carvera-Community/Carvera_Controller/commit/f1d0274db920857f392f93cc77700e87bd3a9bd3)

## Release Schedule Changes

Moving forwards the Carvera Community projects are going to make available new feature releases first as Release Candidates (RC) for a period of time for testing by the wider community before subsequent releases. We ask operators using these releases to provide feedback positive and negative about how they are finding the new functionality in either the #mods channel of the [Makera Discord](https://discord.gg/c6UMjEhaQA) or #feedback in the [Carvera Community Discord](https://discord.gg/2WqrRswQrE). Release candidates are feature locked and thoroughly tested by the community dev team and are designed to catch any minor edge case errors that crop up when expanding the user base before a full release. Thank you in advance to anyone who has the time to help catch the final round of bugs.

## New version milestone!

We feel that so much functionality has been added to the Community Firmware and Controller beyond the OEM that the version 2.0.0 milestone is warranted. Please note that this is still an incremental release and there are no breaking changes from the previous versions.

## What's Changed

- Enhancement: [Continuous jog mode support](https://carvera-community.gitbook.io/docs/controller/features/jogging-controls). Community firmware > 2.0.0c is required for this feature.
- Enhancement: [Configurable Macro buttons](https://carvera-community.gitbook.io/docs/controller/features/macros) added to the Control UI screen. Configure the macros in Controller Settings
- Enhancement: [Auto-Reconnect](https://carvera-community.gitbook.io/docs/controller/features/auto-reconnect) functionality with configurable delay, and attempts
- Enhancement: Add Online Documentation link to Function dropdown
- Enhancement: WBH04 Pendant step size option "Lead" scales the feedrate to the rotational wheel speed of the pendant
- Enhancement: MDI sent/received now logged to log file (if enabled)
- Enhancement: New HALT message when a 3D probe crash was detected
- Change: Jogging option buttons consolidated and always displayed
- Change: Default jog speed is "max" (10k mm/min). Pendant Jog speed uses configured global jog speed
- Change: Jog buttons act now on\_press instead of on\_release
- Change: Probing cancel button becomes halt button if machine is moving
- Change: Machine heartbeat is now 5s to be a bit more responsive on disconnects
- Change: Light toggle button initial state is set on connect
- Change: [Controller logging options](https://carvera-community.gitbook.io/docs/controller/features/logging) now available in settings. Default log\_level is info and log to file is enabled.
- Change: SafeZ positions are now 2mm from the home positions to provide clearance for users of x-sag compensation
- Change: Added config item to skip moving to path origin on gcode playback start. Community firmware > 2.0.0c is required for this feature.
- Fix: Upload-and-Select button is now disabled until a file is selected
- Fix: WBH04 Pendant Macro-10 should be treated as an action button
- Fix: Better handling of machine diagnostic output to support analogue mode spindles
- Fix: XYZ Block probing UI was running the set offset gcode G10L2 instead of M495.3

## Contributors

Thank you to the developers that worked on this release:

- [@WARIO2412](https://github.com/WARIO2412)
- [@SergeBakharev](https://github.com/SergeBakharev)

[v0.10.1](https://github.com/Carvera-Community/Carvera_Controller/releases/tag/v0.10.1)

[SergeBakharev](https://github.com/SergeBakharev) released this 03 Aug 10:36

[v0.10.1](https://github.com/Carvera-Community/Carvera_Controller/tree/v0.10.1)

[`0e2dc20`](https://github.com/Carvera-Community/Carvera_Controller/commit/0e2dc209a63e5b347c46c1f408cf545e4e864234)

## What's Changed

- Change: Added input validation to catch empty values on input boxes
- Fix: Sometimes the machine doesn't response to the initial machine "model" or "version" queries. Attempt to query this machine metadata periodically until it's determined
- Fix: Fixed single axis z probing

**Full Changelog**: [v0.10.0...v0.10.1](https://github.com/Carvera-Community/Carvera_Controller/compare/v0.10.0...v0.10.1)

[v0.10.0](https://github.com/Carvera-Community/Carvera_Controller/releases/tag/v0.10.0)

[SergeBakharev](https://github.com/SergeBakharev) released this 28 Jul 22:42

[v0.10.0](https://github.com/Carvera-Community/Carvera_Controller/tree/v0.10.0)

[`5a106ee`](https://github.com/Carvera-Community/Carvera_Controller/commit/5a106eef80cdfe626bff8e0c369acff1e4adcb41)

## What's Changed

- Enhancement: Support for controlling the machine via WHB04 pendant devices
- Enhancement: Added WCS Management functionality. WCS workspace is displayed in top status bar, and can be used to change between different workspaces (G54-G59.3 etc). Note: Community firmware v1.0.3c1.0.7 is required for full functionality. Community firmware v1.0.3c1.0.6 does support editing the offsets but doesn't track manual G5\* commands in the MDI. Makera firmware will not persist non-G54 offsets across machine resets.
- Enhancement: Ability to rotate the WCS workspace. This is done via the WCS Management options. WCS rotation requires Community firmware 1.0.3c.1.0.7 or higher to function
- Enhancement: Docker image package. This runs the controller and exposes it over a noVNC web browser, so the controller can be used from multiple locations concurrently
- Enhancement: Android apk now supports armv7 (32-bit), armv8 (64-bit), and x86\_64 processors
- Change: Functionality that requires community firmware will be disabled in the Controller if using Makera firmware. Previously it would just not work.
- Change: Clear the WCS rotation if the Gcode file loaded has 4th axis rotation movements
- Change: 4th axis module shape in the preview visualisation in config-and-run screen was for non-harmonic model, now is the correct shape for harmonic version
- Change: Unlocking the machine after a halt gives you the option to move to SafeZ
- Change: Graphics and behavior of the probe boss command are now updated to use diameter and a J parameter instead of radius.
- Change: Show machine model based specific config options
- Fix: Add 3D Probe tool option to Change/Set if CA1. Previously only added for C1
- Fix: Resolve the keyboard\_mode config load error that occurs when reconnecting the Controller after it loses connection
- Fix: Red origin dot in preview visualisation on config-and-run screen returned
- Fix: Last open folder was using temp directory instead of actual user selected location
- Fix: Set origin popup now properly shows the current offset to the anchors when switching options. When set to 'current pos' the offset default to 0.
- Fix: A Axis: WCS coordinate display now shows the correct value
- Fix: A Axis: Set A and A = 0 use the correct commands now (e.g. G10L20A0P0 instead of G92.4 A0)
- Fix: Increase the number of forced window renderings to workaround the Android blank screen issue
- Fix: Set ordering of parameters in probing screens to use the existing ordering instead of first changed
- Fix: Including Q parameter in probe corners
- Fix: Order of probing parameters is the same on every page (E on angle probing page is special)

## New Contributors

- [@leggomyfroggo](https://github.com/leggomyfroggo) made their first contribution in [#251](https://github.com/Carvera-Community/Carvera_Controller/pull/251)
- [@yaqwsx](https://github.com/yaqwsx) made their first contribution in [#232](https://github.com/Carvera-Community/Carvera_Controller/pull/232)

## Contributors

Thank you to the developers that worked on this release:

- [@WARIO2412](https://github.com/WARIO2412)
- [@yaqwsx](https://github.com/yaqwsx)
- [@mcowger](https://github.com/mcowger)
- [@faecorrigan](https://github.com/faecorrigan)
- [@leggomyfroggo](https://github.com/leggomyfroggo)
- [@SergeBakharev](https://github.com/SergeBakharev)

**Full Changelog**: [v0.9.1...v0.10.0](https://github.com/Carvera-Community/Carvera_Controller/compare/v0.9.1...v0.10.0)

## Screenshots

Pendant Config:  
[![pendant_config](https://private-user-images.githubusercontent.com/4798437/471758524-86495cf5-e9e6-4b74-842b-07c249553423.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODY0ODEyMDcsIm5iZiI6MTc4NjQ4MDkwNywicGF0aCI6Ii80Nzk4NDM3LzQ3MTc1ODUyNC04NjQ5NWNmNS1lOWU2LTRiNzQtODQyYi0wN2MyNDk1NTM0MjMucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MDgxMSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjA4MTFUMjA0MTQ3WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9MjhiMGQzZjFhY2JlNjI3ZGE5YjYzMmFmNGVkZGFmYTQ2MmFkNjRhYTA1NzI2Y2RjZDA2YTJlYzNlZTNiZDgzNCZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPWltYWdlJTJGcG5nIn0.sksIezq9bp3V6tdljbnapTsIdudNrRtd389kDnLFtmM)](https://private-user-images.githubusercontent.com/4798437/471758524-86495cf5-e9e6-4b74-842b-07c249553423.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODY0ODEyMDcsIm5iZiI6MTc4NjQ4MDkwNywicGF0aCI6Ii80Nzk4NDM3LzQ3MTc1ODUyNC04NjQ5NWNmNS1lOWU2LTRiNzQtODQyYi0wN2MyNDk1NTM0MjMucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MDgxMSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjA4MTFUMjA0MTQ3WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9MjhiMGQzZjFhY2JlNjI3ZGE5YjYzMmFmNGVkZGFmYTQ2MmFkNjRhYTA1NzI2Y2RjZDA2YTJlYzNlZTNiZDgzNCZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPWltYWdlJTJGcG5nIn0.sksIezq9bp3V6tdljbnapTsIdudNrRtd389kDnLFtmM)

Connected Pendant:  
[![image](https://private-user-images.githubusercontent.com/4798437/471759242-7a1fb21d-ac71-4937-809a-bdbf810b2e27.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODY0ODEyMDcsIm5iZiI6MTc4NjQ4MDkwNywicGF0aCI6Ii80Nzk4NDM3LzQ3MTc1OTI0Mi03YTFmYjIxZC1hYzcxLTQ5MzctODA5YS1iZGJmODEwYjJlMjcucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MDgxMSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjA4MTFUMjA0MTQ3WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9YWU5ZmFkODdlNzNlZjcwOWY2OTc2ZDg3NDMzMTA0MTRiNjQyMWE0YWVkNGM3YWZkNzI5ZDJkOTBjMjk2NWJlNiZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPWltYWdlJTJGcG5nIn0.QvtYHQQsjAU187BepQNlscJUYBpXCNB4FEYgH8eZnAs)](https://private-user-images.githubusercontent.com/4798437/471759242-7a1fb21d-ac71-4937-809a-bdbf810b2e27.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODY0ODEyMDcsIm5iZiI6MTc4NjQ4MDkwNywicGF0aCI6Ii80Nzk4NDM3LzQ3MTc1OTI0Mi03YTFmYjIxZC1hYzcxLTQ5MzctODA5YS1iZGJmODEwYjJlMjcucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MDgxMSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjA4MTFUMjA0MTQ3WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9YWU5ZmFkODdlNzNlZjcwOWY2OTc2ZDg3NDMzMTA0MTRiNjQyMWE0YWVkNGM3YWZkNzI5ZDJkOTBjMjk2NWJlNiZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPWltYWdlJTJGcG5nIn0.QvtYHQQsjAU187BepQNlscJUYBpXCNB4FEYgH8eZnAs)

Workspace Management Topbar:  Workspace Settings:  WCS Rotation:  Controller in Web Browser:  Move to SafeZ after Unlock:  
[![unlock_w_safez_move](https://private-user-images.githubusercontent.com/4798437/471760592-4a180357-51e5-4de3-b88e-c1dcab377d23.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODY0ODEyMDcsIm5iZiI6MTc4NjQ4MDkwNywicGF0aCI6Ii80Nzk4NDM3LzQ3MTc2MDU5Mi00YTE4MDM1Ny01MWU1LTRkZTMtYjg4ZS1jMWRjYWIzNzdkMjMucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MDgxMSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjA4MTFUMjA0MTQ3WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9NTQ2ZTYzYzVlMDJhZmM0YTdhOTAwYzI2OTNhZDg0YjJlNzU4ODBhNDY0MWY0MDY5N2FlYmUwODdjZTUyZWU2NyZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPWltYWdlJTJGcG5nIn0.Cfcjqz_LXKhRbpnB8O6ZCWmYgpfEDSsxPlgaTbfCFoE)](https://private-user-images.githubusercontent.com/4798437/471760592-4a180357-51e5-4de3-b88e-c1dcab377d23.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODY0ODEyMDcsIm5iZiI6MTc4NjQ4MDkwNywicGF0aCI6Ii80Nzk4NDM3LzQ3MTc2MDU5Mi00YTE4MDM1Ny01MWU1LTRkZTMtYjg4ZS1jMWRjYWIzNzdkMjMucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MDgxMSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjA4MTFUMjA0MTQ3WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9NTQ2ZTYzYzVlMDJhZmM0YTdhOTAwYzI2OTNhZDg0YjJlNzU4ODBhNDY0MWY0MDY5N2FlYmUwODdjZTUyZWU2NyZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPWltYWdlJTJGcG5nIn0.Cfcjqz_LXKhRbpnB8O6ZCWmYgpfEDSsxPlgaTbfCFoE)

New Boss Probing:  
[![image](https://private-user-images.githubusercontent.com/4798437/471762728-4204b883-765c-49ba-83b2-9b15058f1ee8.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODY0ODEyMDcsIm5iZiI6MTc4NjQ4MDkwNywicGF0aCI6Ii80Nzk4NDM3LzQ3MTc2MjcyOC00MjA0Yjg4My03NjVjLTQ5YmEtODNiMi05YjE1MDU4ZjFlZTgucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MDgxMSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjA4MTFUMjA0MTQ3WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9MTUwMzIzOTRmZWFiYWQ4ZjY0NzNjNWY0YmYwOTg1YTBjOTlmNGRhMjUwZjkwYjY4NWUzYTQ4MmRiOWQ2YWI4NSZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPWltYWdlJTJGcG5nIn0.JOiwhXuHXv4hoc1Ajvrr2HckO_zkjWfJ0XyWOS7O_vU)](https://private-user-images.githubusercontent.com/4798437/471762728-4204b883-765c-49ba-83b2-9b15058f1ee8.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3ODY0ODEyMDcsIm5iZiI6MTc4NjQ4MDkwNywicGF0aCI6Ii80Nzk4NDM3LzQ3MTc2MjcyOC00MjA0Yjg4My03NjVjLTQ5YmEtODNiMi05YjE1MDU4ZjFlZTgucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MDgxMSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjA4MTFUMjA0MTQ3WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9MTUwMzIzOTRmZWFiYWQ4ZjY0NzNjNWY0YmYwOTg1YTBjOTlmNGRhMjUwZjkwYjY4NWUzYTQ4MmRiOWQ2YWI4NSZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPWltYWdlJTJGcG5nIn0.JOiwhXuHXv4hoc1Ajvrr2HckO_zkjWfJ0XyWOS7O_vU)

[v0.9.1](https://github.com/Carvera-Community/Carvera_Controller/releases/tag/v0.9.1)

[SergeBakharev](https://github.com/SergeBakharev) released this 24 Jun 04:06

[v0.9.1](https://github.com/Carvera-Community/Carvera_Controller/tree/v0.9.1)

[`678d274`](https://github.com/Carvera-Community/Carvera_Controller/commit/678d2741d6afb5fd5eda8c803da52bd010b93d24)

## What's Changed

- Fix: 3D Probe tool number missing a "9". Should be 999990 not 99990
- Fix: Python package builds missing a dep

**Full Changelog**: [v0.9.0...v0.9.1](https://github.com/Carvera-Community/Carvera_Controller/compare/v0.9.0...v0.9.1)