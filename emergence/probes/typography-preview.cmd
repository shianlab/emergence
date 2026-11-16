@echo off
chcp 65001 >nul
cd /d "%~dp0.."
wt.exe -w new new-tab --title "Emergence Typography A-B" --suppressApplicationTitle -d "%CD%" "%CD%\node_modules\node\bin\node.exe" --experimental-ffi --disable-warning=ExperimentalWarning --import tsx probes/typography-native.ts --small
