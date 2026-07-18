@echo off
REM Verify the SCM service-recovery actions are set on a BL4CK install.
REM
REM Run on a FRESH VM after MSI install. An upgrade over a developer-
REM installed agent (where `bl4ck-agent service install` had been run)
REM will look correct even if the MSI CustomAction never fired, so this
REM only proves correctness on a clean-slate install.
REM
REM Expected output for each service:
REM   RESET_PERIOD (in seconds)    : 86400
REM   FAILURE_ACTIONS              : RESTART -- Delay = 5000 milliseconds.
REM                                : RESTART -- Delay = 10000 milliseconds.
REM                                : RESTART -- Delay = 30000 milliseconds.

setlocal
set EXIT=0

echo === Bl4ckAgent ===
sc qfailure Bl4ckAgent | findstr /C:"RESET_PERIOD" /C:"RESTART"
if errorlevel 1 set EXIT=1

echo.
echo === Bl4ckWatchdog ===
sc qfailure Bl4ckWatchdog | findstr /C:"RESET_PERIOD" /C:"RESTART"
if errorlevel 1 set EXIT=1

echo.
if "%EXIT%"=="0" (
  echo OK: recovery actions present on both services.
) else (
  echo FAIL: recovery actions missing on one or both services.
  echo Check that the MSI CustomAction "ConfigureBL4CKFailureActions"
  echo fired during install. Re-run "msiexec /i bl4ck-agent.msi /l*v
  echo install.log" and grep install.log for ConfigureBL4CKFailureActions.
)
exit /b %EXIT%
