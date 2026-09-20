; Register BlockMD with the Windows shell properly.
;
; Tauri's own file-association code writes the ProgId (HKCR\BlockMD.md) and points the
; .md class default at it. That is enough for a double-click *once the user has chosen
; BlockMD* — but it is not enough for the user to choose it in the first place. The
; "Open with" dialog and Settings → Default apps are built from different keys, and
; without them the app is invisible there. Verified with SHAssocEnumHandlers, the same
; API the shell uses: before these hooks existed, .md offered 24 handlers and BlockMD
; was not among them (see scripts/check-assoc.ps1).
;
; Three registrations, each serving a different part of the shell:
;
;   Applications\blockmd.exe   the generic "an app that can open files" entry
;   .md\OpenWithProgids        adds our ProgId to the per-extension candidate list
;   RegisteredApplications     Default Programs capabilities — the Settings page
;
; Written to HKLM because the bundle installs per-machine.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering BlockMD as a Markdown handler..."

  ; --- The application itself -------------------------------------------------
  WriteRegStr HKLM "Software\Classes\Applications\blockmd.exe" "FriendlyAppName" "BlockMD"
  WriteRegStr HKLM "Software\Classes\Applications\blockmd.exe\DefaultIcon" "" "$INSTDIR\blockmd.exe,0"
  WriteRegStr HKLM "Software\Classes\Applications\blockmd.exe\shell\open\command" "" '"$INSTDIR\blockmd.exe" "%1"'
  WriteRegStr HKLM "Software\Classes\Applications\blockmd.exe\SupportedTypes" ".md" ""
  WriteRegStr HKLM "Software\Classes\Applications\blockmd.exe\SupportedTypes" ".markdown" ""

  ; --- Candidate handler for each extension ------------------------------------
  ; A value name, not a default value: an extension may list many ProgIds, and this
  ; adds ours without disturbing whatever else already claims .md.
  WriteRegStr HKLM "Software\Classes\.md\OpenWithProgids" "BlockMD.md" ""
  WriteRegStr HKLM "Software\Classes\.markdown\OpenWithProgids" "BlockMD.md" ""

  ; --- Default Programs capabilities -------------------------------------------
  WriteRegStr HKLM "Software\BlockMD\Capabilities" "ApplicationName" "BlockMD"
  WriteRegStr HKLM "Software\BlockMD\Capabilities" "ApplicationDescription" "A Notion-style block editor whose files are just plain .md"
  WriteRegStr HKLM "Software\BlockMD\Capabilities" "ApplicationIcon" "$INSTDIR\blockmd.exe,0"
  WriteRegStr HKLM "Software\BlockMD\Capabilities\FileAssociations" ".md" "BlockMD.md"
  WriteRegStr HKLM "Software\BlockMD\Capabilities\FileAssociations" ".markdown" "BlockMD.md"
  WriteRegStr HKLM "Software\RegisteredApplications" "BlockMD" "Software\BlockMD\Capabilities"

  ; The shell caches association data; without this the new entries do not appear
  ; until the next sign-in. SHCNE_ASSOCCHANGED = 0x08000000.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Removing BlockMD shell registration..."

  DeleteRegKey HKLM "Software\Classes\Applications\blockmd.exe"
  DeleteRegValue HKLM "Software\Classes\.md\OpenWithProgids" "BlockMD.md"
  DeleteRegValue HKLM "Software\Classes\.markdown\OpenWithProgids" "BlockMD.md"
  DeleteRegValue HKLM "Software\RegisteredApplications" "BlockMD"
  DeleteRegKey HKLM "Software\BlockMD"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
