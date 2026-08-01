@echo off
rem Release launcher (Windows) - runs the pre-built dist/index.js bundle.
rem See bin/cast (the macOS/Linux equivalent) for why the two targeted
rem warning suppressions and CAST_CWD are both here.
setlocal
set "CAST_CWD=%CD%"
node --disable-warning=DEP0040 --disable-warning=ExperimentalWarning "%~dp0..\dist\index.js" %*
