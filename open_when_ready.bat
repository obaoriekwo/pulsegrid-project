@echo off
REM Polls the server every second (up to 60s) and opens the browser
REM ONCE, when it first responds.
REM
REM This uses a top-level goto loop, NOT a "for /L ... do ( ... )"
REM block. An earlier version used a for-loop with "exit /b" (and then
REM "goto") to break out early from inside the loop body - both are
REM unreliable in cmd.exe, because cmd.exe pre-parses an entire
REM parenthesized block before running any of it, so jumping out of
REM that block to a label outside it doesn't work as expected. This
REM caused the real bug of the browser never opening (or opening
REM repeatedly). A goto-based loop with no parentheses avoids the
REM whole problem.

set attempts=0

:poll
set /a attempts+=1
curl -s -o nul http://127.0.0.1:8000/ >nul 2>nul
if not errorlevel 1 goto :ready
if %attempts% GEQ 60 goto :giveup
timeout /t 1 >nul
goto :poll

:ready
start http://127.0.0.1:8000/
goto :eof

:giveup
REM Silent timeout - start.bat's own window will still show whether
REM the server actually started; this script just gives up opening
REM the browser automatically.
goto :eof
