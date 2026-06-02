@echo off
rem Change directory to batch file folder
cd /d "%~dp0"

rem Set Python IO encoding to UTF-8 to prevent UnicodeEncodeError with emojis
set PYTHONIOENCODING=utf-8

rem Activate virtual environment
call .venv\Scripts\activate

rem Run Python scraper script
python -u main.py

rem --- [Cloudflare R2 Upload] ---
rem Upload the latest dashboard data to Cloudflare R2
echo === Uploading dashboard data to Cloudflare R2... ===
python -u src/upload_to_r2.py
if errorlevel 1 (
    echo [ERROR] R2 upload failed. Please check your .env credentials or network.
    exit /b 1
)
echo === Upload Completed ===

