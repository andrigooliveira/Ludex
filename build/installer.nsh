; Personalização do instalador. O electron-builder inclui este arquivo sozinho
; (build/installer.nsh) e chama as macros abaixo nos pontos certos do modelo dele.
; As imagens (installerSidebar.bmp, installerHeader.bmp) saem de scripts/build-app-icon.js.

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var glShortcutsShown
  Var glDesktop
  Var glStartMenu
  Var glDesktopBox
  Var glStartMenuBox
!endif

; Cores do app: valem para as páginas de boas-vindas/conclusão e para a faixa do
; título das outras. Precisam ser definidas antes da primeira página.
!macro glColors
  !ifndef MUI_BGCOLOR
    !define MUI_BGCOLOR "0A0A0A"
  !endif
  !ifndef MUI_TEXTCOLOR
    !define MUI_TEXTCOLOR "EAEAEA"
  !endif
!macroend

!macro customWelcomePage
  !insertmacro glColors
  !define MUI_WELCOMEPAGE_TITLE "Ludex ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "Todos os seus jogos num lugar só: Steam, Epic, GOG, Ubisoft, EA e os que você adicionar à mão, com downloads integrados.$\r$\n$\r$\nNas próximas telas você escolhe a pasta de instalação e os atalhos.$\r$\n$\r$\nClique em Próximo para continuar."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !insertmacro glColors
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; Instala sempre para o usuário atual: não pede administrador nem mostra a
; página "para quem instalar".
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Página de atalhos, entre a escolha da pasta e a instalação.
!macro customPageAfterChangeDir
  Page custom glShortcutsCreate glShortcutsLeave

  Function glShortcutsCreate
    ${if} ${isUpdated}
      Abort
    ${endIf}

    ; Primeira vez na página: tudo marcado; reinstalando, o que já existia.
    ${if} $glShortcutsShown != "1"
      StrCpy $glShortcutsShown "1"
      StrCpy $glDesktop ${BST_CHECKED}
      StrCpy $glStartMenu ${BST_CHECKED}
      ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${if} $0 != ""
        ${ifNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
          StrCpy $glDesktop ${BST_UNCHECKED}
        ${endIf}
        ${ifNot} ${FileExists} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
          StrCpy $glStartMenu ${BST_UNCHECKED}
        ${endIf}
      ${endIf}
    ${endIf}

    !insertmacro MUI_HEADER_TEXT "Atalhos" "Escolha onde criar atalhos para abrir o Ludex."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 20u "Marque os atalhos que você quer. Dá para criar ou apagar qualquer um deles depois, rodando o instalador de novo."
    Pop $0
    ${NSD_CreateCheckbox} 0 32u 100% 12u "Criar atalho na Área de Trabalho"
    Pop $glDesktopBox
    ${NSD_SetState} $glDesktopBox $glDesktop
    ${NSD_CreateCheckbox} 0 50u 100% 12u "Criar atalho no Menu Iniciar"
    Pop $glStartMenuBox
    ${NSD_SetState} $glStartMenuBox $glStartMenu
    ${NSD_CreateLabel} 0 72u 100% 20u "Sem o atalho no Menu Iniciar, o Windows pode não mostrar as notificações de download concluído."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function glShortcutsLeave
    ${NSD_GetState} $glDesktopBox $glDesktop
    ${NSD_GetState} $glStartMenuBox $glStartMenu

    ; A instalação é sem administrador: confere se dá para gravar na pasta escolhida.
    ClearErrors
    CreateDirectory "$INSTDIR"
    FileOpen $0 "$INSTDIR\.gl-teste" w
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Não dá para gravar nesta pasta:$\r$\n$INSTDIR$\r$\n$\r$\nVolte e escolha outra pasta, ou feche o instalador e execute-o como administrador."
      Abort
    ${endIf}
    FileClose $0
    Delete "$INSTDIR\.gl-teste"
    RMDir "$INSTDIR"
  FunctionEnd
!macroend

; Depois de copiar os arquivos: deixa os atalhos como foi marcado na página.
!macro customInstall
  ; Pela interface própria (instalação silenciosa): sem atalho no Menu Iniciar, se pedido.
  ; O da Área de Trabalho o modelo do electron-builder já tira com --no-desktop-shortcut.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--no-start-menu-shortcut" $R1
  ${IfNot} ${Errors}
    WinShell::UninstShortcut "$newStartMenuLink"
    Delete "$newStartMenuLink"
    StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}

  ${if} $glShortcutsShown == "1"
    ${if} $glDesktop == ${BST_CHECKED}
      ${ifNot} ${FileExists} "$newDesktopLink"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${endIf}
    ${else}
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${endIf}

    ${if} $glStartMenu == ${BST_CHECKED}
      ${ifNot} ${FileExists} "$newStartMenuLink"
        CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      ${endIf}
      StrCpy $launchLink "$newStartMenuLink"
    ${else}
      WinShell::UninstShortcut "$newStartMenuLink"
      Delete "$newStartMenuLink"
      StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${endIf}
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${endIf}
!macroend

; Página de conclusão: a do modelo, mais um ajuste na caixa "Executar".
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW glFinishShow
  !insertmacro MUI_PAGE_FINISH

  ; (Definida depois da página: a variável da caixa só existe a partir dela.)
  ; Com o tema do Windows, a caixa de marcação ignora a cor do texto e ficaria
  ; preta sobre o fundo escuro; sem o tema ela obedece às cores do instalador.
  Function glFinishShow
    StrCpy $0 $mui.FinishPage.Run
    System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
  FunctionEnd
!macroend
