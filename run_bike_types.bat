@echo off
rem Change directory to batch file folder
cd /d "%~dp0"

rem Set Python IO encoding to UTF-8 to prevent UnicodeEncodeError
set PYTHONIOENCODING=utf-8

rem Activate virtual environment
call .venv\Scripts\activate

rem Run Python scraper script for bike types and masters
python -u main.py --bike-types

rem --- [GitHub Pages Auto Deploy] ---
rem Push the latest bike types, master and dashboard data to GitHub Pages
echo === Pushing latest bike types and dashboard data to GitHub... ===
"C:\Program Files\Git\cmd\git.exe" add output/bike_types.csv output/vehicle_type_master.csv dashboard_data.json dashboard_data.js
"C:\Program Files\Git\cmd\git.exe" commit -m "Manual-update bike types and master dashboard data [skip ci]"
"C:\Program Files\Git\cmd\git.exe" push origin master
echo === Deploy Completed ===
