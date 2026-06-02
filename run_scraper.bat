@echo off
rem Change directory to batch file folder
cd /d "%~dp0"

rem Set Python IO encoding to UTF-8 to prevent UnicodeEncodeError with emojis
set PYTHONIOENCODING=utf-8

rem Activate virtual environment
call .venv\Scripts\activate

rem Run Python scraper script
python -u main.py

rem --- [GitHub Pages Auto Deploy] ---
rem Push the latest dashboard data to GitHub Pages
echo === Pushing latest dashboard data to GitHub... ===
"C:\Program Files\Git\cmd\git.exe" add dashboard_data.json dashboard_data.js
"C:\Program Files\Git\cmd\git.exe" commit -m "Auto-update map dashboard data from local [skip ci]"
"C:\Program Files\Git\cmd\git.exe" push origin master
echo === Deploy Completed ===
